import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import pdf from 'pdf-parse';
import cron from 'node-cron';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

const generalLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 100,
	message: {error: "Πολλά αιτήματα. Δοκίμασε σε λίγο."},
	standardHeaders: true,
	legacyHeaders: false,
});

const chatLimiter = rateLimit({
	windowMs: 1 * 60 * 1000,
	max: 10,
	message: {error: "Αργή αποστολή μηνυμάτων παρακαλώ."},
});

const app = express();
app.use(cors({ origin: 'https://ci.aegean.gr' }));
app.use(express.json({ limit: '10kb' }));
app.use(generalLimiter);

const ACTIVE_MODEL = "gemma3:12b";
const EMBED_MODEL = "nomic-embed-text";
const VECTOR_STORE_PATH = "./vector_store.json";
const WORDPRESS_URL = "https://ci.aegean.gr";
const CHUNK_SIZE = 500;      
const CHUNK_OVERLAP = 80;    
const TOP_K = 3;             
const SIMILARITY_THRESHOLD = 0.70;

const IMPORTANT_PAGES = [
   {url: "https://ci.aegean.gr/%ce%b3%ce%b5%ce%bd%ce%b9%ce%ba%ce%ac/", title:"Οδηγός Σπουδών"},
    {url: "https://ci.aegean.gr/about/", title: "Σχετικά με το ΠΜΣ"},
    {url: "https://ci.aegean.gr/%ce%bf%ce%b4%ce%b9%ce%ba%cf%8c%cf%82-%cf%87%ce%ac%cf%81%cf%84%ce%b7%cf%82/", title: "Οδικός Χάρτης Φοιτητή"},
    {url: "https://ci.aegean.gr/%ce%ba%ce%b1%ce%bd%ce%bf%ce%bd%ce%b9%cf%83%ce%bc%ce%bf%ce%af/", title: "Κανονισμοί ΠΜΣ"},
    {url: "https://ci.aegean.gr/%ce%bc%ce%bf%cf%85%cf%83%ce%b5%ce%b9%ce%bf%ce%bb%ce%bf%ce%b3%ce%af%ce%b1/", title: "Κατεύθυνση Μουσειολογία"},
    {url: "https://ci.aegean.gr/%cf%83%cf%87%ce%b5%ce%b4%ce%b9%ce%ac%cf%83%ce%b7-%cf%80%ce%bf%ce%bb%ce%b9%cf%84%ce%b9%cf%83%cf%84%ce%b9%ce%ba%cf%8e%ce%bd-%cf%88%ce%b7%cf%86%ce%b9%ce%b1%ce%ba%cf%8e%ce%bd-%cf%80%cf%81%ce%bf%cf%8a/", title: "Κατεύθυνση Σχεδίαση Ψηφιακών Πολιτιστικών Προϊόντων"},
    {url: "https://ci.aegean.gr/%cf%80%ce%bf%ce%bb%ce%b9%cf%84%ce%b9%cf%83%ce%bc%cf%8c%cf%82-%ce%ba%ce%b1%ce%b9-%cf%80%ce%b1%cf%81%ce%b1%ce%b3%cf%89%ce%b3%ce%ae-%ce%bd%cf%84%ce%bf%ce%ba%ce%b9%ce%bc%ce%b1%ce%bd%cf%84%ce%ad%cf%81/", title: "Κατεύθυνση Πολιτισμός και παραγωγή ταινιών ντοκιμαντέρ"},
    {url: "https://ci.aegean.gr/%cf%83%cf%8d%ce%bc%ce%b2%ce%bf%cf%85%ce%bb%ce%bf%ce%b9-%cf%83%cf%80%ce%bf%cf%85%ce%b4%cf%8e%ce%bd/", title: "Σύμβουλοι Σπουδών / Ακαδημαϊκοί Σύμβουλοι"}
];


let VECTOR_STORE = [];

async function saveVectorStore() {
    await fs.promises.writeFile(VECTOR_STORE_PATH, JSON.stringify(VECTOR_STORE));
    console.log(`💾 Vector store αποθηκεύτηκε (${VECTOR_STORE.length} chunks)`);
}

function loadVectorStore() {
    if (fs.existsSync(VECTOR_STORE_PATH)) {
        try {
            VECTOR_STORE = JSON.parse(fs.readFileSync(VECTOR_STORE_PATH, 'utf-8'));
            VECTOR_STORE = VECTOR_STORE.filter(c => c.embedding && c.embedding.length > 0);
            console.log(`📂 Vector store φορτώθηκε (${VECTOR_STORE.length} chunks)`);
            return true;
        } catch (err) {
            console.error("❌ Corrupted vector_store.json — κάνω full re-fetch...");
            return false;
        }
    }
    return false;
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

async function getEmbedding(text) {
    const limits = [3000, 2000, 1000];
    for (const limit of limits) {
        try {
            const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: EMBED_MODEL, prompt: text.substring(0, limit) })
            });
            const data = await res.json();
            if (!data.embedding || data.embedding.length === 0) {
                console.warn(`⚠️ Αποτυχία με limit ${limit} | ${JSON.stringify(data).substring(0, 100)}`);
                continue;
            }
            return data.embedding;
        } catch (err) {
            console.error("❌ getEmbedding error:", err.message);
        }
    }
    return null;
}

async function getEmbeddingWithRetry(text, retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const emb = await getEmbedding(text);
        if (emb) return emb;
        console.warn(`⚠️ Retry ${attempt}/${retries}...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
    }
    return null;
}

function splitIntoChunks(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const words = text.split(/\s+/).filter(Boolean);
    const chunks = [];
    for (let i = 0; i < words.length; i += size - overlap) {
        const chunk = words.slice(i, i + size).join(' ');
        if (chunk.trim().length > 80) chunks.push(chunk);
        if (i + size >= words.length) break;
    }
    return chunks;
}

function stripHTML(html) {
    if (!html) return "";
    let t = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<[^>]*>/gm, ' ')
        .replace(/\s\s+/g, ' ')
        .trim();
    return t;
}

function findPDFLinks(html, baseUrl) {
    const regex = /href="([^"]+\.pdf)"/gi;
    const links = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        try {
            const url = match[1].startsWith('http')
                ? match[1]
                : new URL(match[1], baseUrl).href;
            links.push(url);
        } catch (_) {}
    }
    return [...new Set(links)];
}

async function readPDFContent(url) {
    try {
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        const data = await pdf(Buffer.from(buffer));
        return data.text.replace(/\s+/g, " ").trim();
    } catch {
        console.error(`❌ Απέτυχε PDF: ${url}`);
        return "";
    }
}

async function findRelevantContext(query) {
    if (!query || VECTOR_STORE.length === 0) return "NO_RELEVANT_DATA";

    const STOP_ONLY = ["γεια", "καλημερα", "καλησπερα", "ευχαριστω", "αντιο"];
    const normalized = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (STOP_ONLY.some(w => normalized.includes(w)) && normalized.split(' ').length <= 2) {
        return "";
    }

    console.log(`\n🔎 Semantic search για: "${query}"`);
    
    const queryEmbedding = await getEmbedding(query);
    if (!queryEmbedding) {
    	console.warn("⚠️ Αδύνατη η δημιουργία query embedding");
	return "NO_RELEVANT_DATA";
    }

    const scored = VECTOR_STORE
        .filter(chunk => chunk.embedding && chunk.embedding.length > 0)
	.map(chunk => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    const seen = {};
    const top = scored
    .filter(c => c.score >= SIMILARITY_THRESHOLD)
    .sort((a,b) => b.score - a.score)
    .filter(c => {
        seen[c.url] = (seen[c.url] || 0) + 1;
        return seen[c.url] <= 2;
    })
    .slice(0, TOP_K);

    if (top.length === 0) {
        console.log(`⚠️ Κανένα chunk πάνω από threshold ${SIMILARITY_THRESHOLD}`);
        return "NO_RELEVANT_DATA";
    }

    console.log(`📊 Top chunk score: ${top[0].score.toFixed(3)} | Βρέθηκαν: ${top.length}`);
    top.forEach((c, i) => {
    	console.log(`  #${i+1} [${c.score.toFixed(3)}] ${c.title} | ${c.content.substring(0, 80)}...`);
    });

    return top.map((c, i) =>
        `=== ΑΠΟΤΕΛΕΣΜΑ #${i+1} (score: ${c.score.toFixed(3)}) ===\nΠΗΓΗ: ${c.title}\nLink: ${c.url}\nΚΕΙΜΕΝΟ: ${c.content}\n---`
    ).join('\n\n');
}

async function unloadLLM() {
    await fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ACTIVE_MODEL, keep_alive: 0 })
    });
    console.log("🔄 LLM unloaded από VRAM για embedding...");
    await new Promise(r => setTimeout(r, 2000)); 
}

async function fetchWithTimeout(url, timeout = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return res;
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

async function fetchAndEmbedAll() {
    await unloadLLM();
    console.log("🔄 ΕΚΚΙΝΗΣΗ ΣΥΓΧΡΟΝΙΣΜΟΥ + EMBEDDING...");
    const rawChunks = [];  
    const pdfsToRead = [];

    for (const page of IMPORTANT_PAGES) {
        try {
            console.log(`📥 Σελίδα: ${page.url}`);
            const res = await fetchWithTimeout(page.url);
            const html = await res.text();
            const cleanText = stripHTML(html);

            splitIntoChunks(cleanText).forEach((chunk, idx) => {
                rawChunks.push({ title: `${page.title} [${idx+1}]`, url: page.url, content: chunk });
            });

            findPDFLinks(html, page.url).forEach(link =>
                pdfsToRead.push({ title: page.title, url: link })
            );
        } catch (err) {
            console.error(`❌ Σφάλμα: ${page.url}`, err.message);
        }
    }
   
     const importantUrls = new Set(IMPORTANT_PAGES.map(p => p.url));
     let posts = [], pages = [];
     try {
     	const [postsRes, pagesRes] = await Promise.all([
        	fetch(`${WORDPRESS_URL}/wp-json/wp/v2/posts?per_page=40`),
        	fetch(`${WORDPRESS_URL}/wp-json/wp/v2/pages?per_page=20`)
    	]);
    	posts = await postsRes.json();
    	pages = await pagesRes.json();
	console.log(`Wordpress: ${posts.length} posts, ${pages.length} pages`);
     } catch (err) {
        console.error("Wordpress API failed:", err.message);
     }

    [...(Array.isArray(pages) ? pages : []), ...(Array.isArray(posts) ? posts : [])].forEach(item => {
        if (importantUrls.has(item.link)) return;
        const text = stripHTML(item.content.rendered);
        splitIntoChunks(text).forEach((chunk, idx) => {
            rawChunks.push({ title: `${item.title.rendered} [${idx+1}]`, url: item.link, content: chunk });
        });
        findPDFLinks(item.content.rendered, item.link).forEach(link =>
            pdfsToRead.push({ title: item.title.rendered, url: link })
        );
    });

    const uniquePdfs = pdfsToRead.filter((v, i, a) => a.findIndex(x => x.url === v.url) === i);
    console.log(`📂 PDFs για κατέβασμα: ${uniquePdfs.length}`);

    for (const pdfItem of uniquePdfs) {
        const text = await readPDFContent(pdfItem.url);
        if (text.length > 80) {
            splitIntoChunks(text).forEach((chunk, idx) => {
                rawChunks.push({ title: `PDF: ${pdfItem.title} [${idx+1}]`, url: pdfItem.url, content: chunk });
            });
        }
    }

    console.log(`\n🧠 Δημιουργία embeddings για ${rawChunks.length} chunks...`);

    const embedded = [];
    for (let i = 0; i < rawChunks.length; i++) {
        const chunk = rawChunks[i];
    	if (!chunk.content || chunk.content.trim().length < 10) {
        	console.warn(`⚠️ ΚΕΝΟ CHUNK [${i}]: "${chunk.title}" | URL: ${chunk.url}`);
        	continue; 
    	}
	    try {
            const embedding = await getEmbeddingWithRetry(chunk.content);
            if (!embedding) {
 	         console.warn(`⚠️ NULL EMBEDDING: "${chunk.title}" | ${chunk.url}`);
    		continue;
            }
	    if ((i + 1) % 20 === 0) console.log(`  ✅ ${i + 1}/${rawChunks.length} chunks embedded`);
	    embedded.push({ ...chunk, embedding, id: `chunk_${i}` });
	    await new Promise(r => setTimeout(r, 300));
        } catch (err) {
            console.error(`❌ Embedding απέτυχε για chunk ${i}:`, err.message);
        }
    }

    VECTOR_STORE = embedded;
    await saveVectorStore(); 
    console.log(`✅ ΕΤΟΙΜΟΣ! ${VECTOR_STORE.length} chunks με embeddings στη μνήμη.`);
}

const loaded = loadVectorStore();
if (!loaded) {
    fetchAndEmbedAll();
} else {
    console.log("⚡ Χρησιμοποιώ cached vector store. Κανένα re-embed στην εκκίνηση.");
}

cron.schedule('0 23 * * 5', async () => {
    const ts = new Date().toLocaleString('el-GR');
    console.log(`\n📅 [${ts}] Εβδομαδιαίο re-embed...`);
    await fetchAndEmbedAll();
    console.log(`✅ [${ts}] Ολοκληρώθηκε.`);
});

function getHardcodedCourseReply(message) {
    const isApplication = /δικαιολογητικ/i.test(message);

    if (isApplication) return "Για την αίτηση εισαγωγής στο ΠΜΣ απαιτούνται: \n\n-Αίτηση υποψηφιότητας\n-Αναλυτικό βιογραφικό σημείωμα\n-Αντίγραφο πτυχίου/διπλώματος ή Βεβαίωση Περάτωσης Σπουδών\n-Πιστοποιητικό αναλυτικής βαθμολογίας προπτυχιακών μαθημάτων με το βαθμό πτυχίου (ή τον μέσο όρο βαθμολογίας, σε περίπτωση που ο/η υποψήφιος/α είναι τελειόφοιτος/η)\n-Ψηφιακό αρχείο της Διπλωματικής/πτυχιακής εργασίας (εφόσον εκπονήθηκε στο πλαίσιο των προπτυχιακών σπουδών και είναι σχετική με το αντικείμενο του ΠΜΣ)\n-Πιστοποιητικό γλωσσομάθειας της Αγγλικής γλώσσας, επιπέδου τουλάχιστον Β2 (εφόσον υπάρχει)\n-Πιστοποιητικό ελληνομάθειας από πιστοποιημένο Κέντρο Ελληνικής Γλώσσας (για τους αλλοδαπούς υποψήφιους)\n-Επιστημονικές δημοσιεύσεις ή/και φάκελος καλλιτεχνικού έργου σχετικά με το αντικείμενο σπουδών του ΠΜΣ, εάν υπάρχουν\n-Αποδεικτικά επαγγελματικής ή ερευνητικής δραστηριότητας σχετικά με το αντικείμενο σπουδών του ΠΜΣ, εάν υπάρχουν\n-Δύο (2) συστατικές επιστολές\n-Φωτοτυπία δύο όψεων αστυνομικής ταυτότητας ή διαβατηρίου\n-Κάθε άλλο στοιχείο που, κατά τη γνώμη των υποψηφίων, θα συνέβαλλε ώστε η Επιτροπή Αξιολόγησης να σχηματίσει πληρέστερη άποψη"

    const isCourseInquiry = /μαθημα|μαθήμα/i.test(message);
    if (!isCourseInquiry) return null;

    const isMuseology = /μουσειολογ/i.test(message);
    const isDigital = /σχεδιασ[ηή][σς]?\s*ψηφιακ|ψηφιακ[αάωώ][νς]?\s*π(ολιτιστικ|ροϊοντ)|σψπ(?!\w)/i.test(message);
    const isDoc = /πολιτισμ[οό]ς\s*και\s*παραγωγ|ντοκιμαντ|ππν/i.test(message);
    const isWinter = /χειμεριν|πρ[ωώ]το|(?<=^|\s)1ο|(?<=^|\s)α(['']|(?=\s|$))/i.test(message);
    const isSpring = /εαριν|δε[υύ]τερο|(?<=^|\s)2ο|(?<=^|\s)β(['']|(?=\s|$))/i.test(message);

    if (isMuseology && isWinter)  return "Τα μαθήματα του Α' (Χειμερινού) Εξαμήνου για την κατεύθυνση Μουσειολογία είναι:\n\n- Διαχείριση της Πληροφορίας\n- Εισαγωγή στη Μουσειολογία\n- Πολιτιστικός Σχεδιασμός\n- Οπτική Επικοινωνία";
    if (isMuseology && isSpring)  return "Τα μαθήματα του Β' (Εαρινού) Εξαμήνου για την κατεύθυνση Μουσειολογία είναι:\n\n- Εκθεσιακός Σχεδιασμός\n- Εφαρμογές Γραφιστικής σε Εκθεσιακό Περιβάλλον\n- Αναδυόμενες Τεχνολογίες στον Πολιτισμό\n- Οπτικοακουστικά Μέσα και Εκθέσεις";
    if (isDigital  && isWinter)   return "Τα μαθήματα του Α' (Χειμερινού) Εξαμήνου για την κατεύθυνση Σχεδίαση Ψηφιακών Πολιτιστικών Προϊόντων είναι:\n\n- Πολιτιστική Διαδραστική Αφήγηση: Απο τα Δεδομένα στο Σενάριο\n- Τριδιάστατα Γραφικά\n- Προγραμματισμός Παιχνιδιών και Εφαρμογών σε Περιβάλλοντα Εκτεταμένης Πραγματικότητας με τη γλώσσα C# 1 \n- Σχεδιασμός Παιχνιδιών";
    if (isDigital  && isSpring)   return "Τα μαθήματα του Β' (Εαρινού) Εξαμήνου για την κατεύθυνση Σχεδίαση Ψηφιακών Πολιτιστικών Προϊόντων είναι:\n\n- Δημιουργία Περιεχομένου για Ψηφιακές Εφαρμογές\n- Γραφιστικός Σχεδιασμός για Διεπαφές χρήστη για Η/Υ, Κινητές Εφαρμογές Εικονικής και Μικτής Πραγματικότητας\n- Ανάπτυξη Παιχνιδιών και Εφαρμογών σε Περιβάλλοντα Μικτής και Εικονικής Πραγματικότητας ΙΙ\n- Ζητήματα Έρευνας και Πειραματικού Σχεδιασμού σε Περιβάλλοντα Εκτεταμένης Πραγματικότητας";
    if (isDoc      && isWinter)   return "Τα μαθήματα του Α' (Χειμερινού) Εξαμήνου για την κατεύθυνση Πολιτισμός και παραγωγή ταινιών ντοκιμαντέρ είναι:\n\n- Ιστορία και Θεωρία του Ντοκιμαντέρ Ι\n- Σενάριο, Σκηνοθεσία και Εικονοληψία Ι. Βασικές Αρχές\n- Μοντάζ και Επεξεργασία Υλικού Ι\n- Ειδικά Θέματα Οπτικοακουστικών Τεχνών Ι";
    if (isDoc      && isSpring)   return "Τα μαθήματα του Β' (Εαρινού) Εξαμήνου για την κατεύθυνση Πολιτισμός και παραγωγή ταινιών ντοκιμαντέρ είναι:\n\n- Ιστορία και Θεωρία του Ντοκιμαντέρ ΙΙ\n- Σενάριο, Σκηνοθεσία και Εικονοληψία ΙΙ. Είδος, Μορφή, Ύφος\n- Μοντάζ και Επεξεργασία Υλικού ΙΙ\n- Ειδικά Θέματα Οπτικοακουστικών Τεχνών ΙΙ\n\nΣημείωση: Περιλαμβάνεται επίσκεψη στο Φεστιβάλ Ντοκιμαντέρ Θεσσαλονίκης.";
    
    return null;
}

app.post('/chat', chatLimiter,  async (req, res) => {
    const { message, history = [] } = req.body; 
    if (!message || message.trim().length === 0) {
	return res.status(400).json({error: "Κενό μήνυμα."})
    }
    if (message.length > 500) {
   	return res.status(400).json({error: "Το μήνυμα είναι πολύ μεγάλο (max 500 χαρακτήρες)."});
    }
    const safeHistory = Array.isArray(history)
	? history.slice(-4).filter(m =>
		typeof m.content === 'string' && m.content.length < 1000
	)
	: [];


    const hardcoded = getHardcodedCourseReply(message);
    if (hardcoded) return res.json({ reply: hardcoded });

    const relevantContext = await findRelevantContext(message);

    const systemInstruction = `
    Είσαι ο Ψηφιακός Βοηθός του ΠΜΣ "Πολιτισμική Πληροφορική και Επικοινωνία" στο Πανεπιστήμιο Αιγαίου. Απαντάς ΑΥΣΤΗΡΑ στα Ελληνικά, με φυσικό, άμεσο και ανθρώπινο ύφος.

    [ΒΑΣΙΚΗ ΓΝΩΣΗ - ΑΔΙΑΠΡΑΓΜΑΤΕΥΤΑ FACTS]
    - Τοποθεσία / Έδρα: Η έδρα του ΠΜΣ και του Τμήματος βρίσκεται ΑΠΟΚΛΕΙΣΤΙΚΑ στη Μυτιλήνη (Λέσβος).
    - Τμήμα: Ανήκει στο "Τμήμα Πολιτισμικής Τεχνολογίας και Επικοινωνίας" (ΤΠΤΕ).
    - ECTS: Απαιτούνται ακριβώς 90 ECTS.
    - Διάρκεια: 3 εξάμηνα (2 κανονικά + 1 για διπλωματική εργασία).
    - Τρόπος παρακολούθησης: Το ΠΜΣ αξιοποιεί υβριδικές μορφές μάθησης (blended learning). Συγκεκριμένα, τα δύο πρώτα εξάμηνα σπουδών είναι αφιερωμένα σε μαθήματα που πραγματοποιούνται, κατά το μεγαλύτερο μέρος τους, εξ αποστάσεως (σε ποσοστό έως και 80%), σε τακτικές προκαθορισμένες συναντήσεις μέσω πλατφόρμας σύγχρονης εξ αποστάσεως εκπαίδευσης. Το υπόλοιπο μέρος του προγράμματος υλοποιείται με σύντομης διάρκειας εντατικούς κύκλους μαθημάτων, στην έδρα του Τμήματος στη Μυτιλήνη.
    - Δίδακτρα:  Για την παρακολούθηση του ΠΜΣ προβλέπεται η καταβολή τελών φοίτητης ύψους 2.800€. Πρώτη δόση ύψους 1.000€ με την εγγραφή. Δεύτερη δόση ύψους 500€ έως τις 31/1/2027. Τρίτη δόση ύψους 500€ έως τις 30/6/2027. Τέταρτη δόση ύψους 800€ πριν την υποστήριξη της Διπλωματικής Εργασίας δηλαδή πριν την λήξη του Γ' Εξαμήνου Σπουδών. 
    - Κατευθύνσεις:
        1.  Μουσειολογία: Εκθεσιακός σχεδιασμός, διαχείριση πολιτιστικής κληρονομιάς, μουσειακές εφαρμογές.
        2.  Σχεδίαση Ψηφιακών Πολιτιστικών Προϊόντων (ΣΨΠΠ): Τρισδιάστατα γραφικά, VR/MR, ανάπτυξη ψηφιακών πολιτιστικών προϊόντων.
        3.  Πολιτισμός και Παραγωγή Ταινιών Ντοκιμαντέρ (ΠΠΤΝ): Σκηνοθεσία, μοντάζ, παραγωγή ντοκιμαντέρ.
    - Ακαδημαϊκοί Σύμβουλοι Σπουδών
        1. Μουσειολογία: Αναστασία Χουρμουζιάδη (nassiah@aegean.gr).
        2. Σχεδίαση Ψηφιακών Πολιτιστικών Προϊόντων (ΣΨΠΠ): Βλάσιος Κασαπάκης (v.kasapakis@aegean.gr).
        3. Πολιτισμός και Παραγωγή Ταινιών Ντοκιμαντερ / Οπτικοακουστικά (ΠΠΤΝ): Δέσποινα Πούλου (d.poulou@aegean.gr).
    - Αιτήσεις: Υποβάλλονται ηλεκτρονικά μέσω του συστήματος Ναυτίλος (nautilus.aegean.gr). Μην αναφέρεις άλλη διεύθυνση ή URL.
    - Επικοινωνία: Τα τηλέφωνα της Γραμματείας είναι 2251036605 και 2251036604. Το email είναι culturaltec.msc@aegean.gr.

    [ΑΥΣΤΗΡΟΙ ΚΑΝΟΝΕΣ]
    1. Απαντάς με πληροφορίες που υπάρχουν στο CONTEXT ή στην ΒΑΣΙΚΗ ΓΝΩΣΗ. Αν η απάντηση υπονοείται απο το context, χρησιμοποίησέ την.
    2. Αν δεν υπάρχει η απάντηση, πες: "Λυπάμαι, δεν διαθέτω αυτή την πληροφορία. Παρακαλώ επικοινωνήστε με τη Γραμματεία: 22510-36604/22510-36605 ή culturaltec.msc@aegean.gr"
    3. Μην κάνεις εικασίες, μην γενικεύεις, μην συμπληρώνεις κενά.
    4. Μην αναφέρεις άλλες κατευθύνσεις όταν η ερώτηση αφορά συγκεκριμένη
    5. Αν σε ρωτήσουν ποιά μαθήματα διδάσκονται στο ΠΜΣ, ζήτα να διευκρινίσουν για ποιά κατεύθυνση και εξάμηνο ρωτάνε.

    [ΠΑΡΕΧΟΜΕΝΟ CONTEXT]
    ${relevantContext === "NO_RELEVANT_DATA" ? "Δεν βρέθηκε σχετικό context." : relevantContext}
        `.trim();
     
    const fullPrompt = [
   	 { role: "system", content: systemInstruction },
    	...safeHistory,
    	{ role: "user", content: message }
    ];

    const totalChars = fullPrompt.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 3); 
    console.log(`📏 Εκτιμώμενα tokens: ${estimatedTokens}`);

    try {
        const response = await fetch("http://127.0.0.1:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: ACTIVE_MODEL,
                messages: [
                    { role: "system", content: systemInstruction },
                    ...safeHistory,  
                    { role: "user", content: message }
                ],
                stream: false,
                options: { num_ctx: 16384, temperature: 0.4 }
            })
        });

        const data = await response.json();
        let reply = data.message?.content || "Error";


        reply = reply.replace(/^(Σύμφωνα με το κείμενο|Σύμφωνα με τις πληροφορίες|Με βάση τα παραπάνω|Όπως αναφέρεται)[,:]?\s*/gi, "");
        reply = reply.replace(/\*\*/g, "").replace(/#{1,6}\s?/g, "");
        reply = reply.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/(?!nautilus\.aegean\.gr)[^\s]+/g, "");
        reply = reply.replace(/\[\s*Απάντηση βασισμένη στα.*?\]/gi, "");
        reply = reply.replace(/\[\s*\]/g, "").replace(/\n\s*\n/g, "\n\n").trim();
        reply = reply.charAt(0).toUpperCase() + reply.slice(1);

	    console.log("🔍 PRE-FILTER REPLY:", reply.substring(0, 300));
        const FORBIDDEN = ["αίγινα", "ρόδο", "αριστοτέλειο", "απθ", "εκπα", "αθήνα", "αθηνα", "σύρο", "χίος", "χιος", "σάμος", "λήμνος"];
        const lower = reply.toLowerCase();
        const hasForbidden = FORBIDDEN.some(loc => {
        const regex = new RegExp(`\\b${loc}\\b`, 'i');
                return regex.test(lower);
        });
        const hasMytilene  = lower.includes("μυτιλην") || lower.includes("λεσβ");
        const badThess     = lower.includes("θεσσαλονίκ") && !lower.includes("ντοκιμαντέρ") && !lower.includes("φεστιβάλ");

        console.log(`🔍 hasForbidden: ${hasForbidden} | hasMytilene: ${hasMytilene} | badThess: ${badThess}`);
        console.log(`🔍 Forbidden word: ${FORBIDDEN.find(loc => lower.includes(loc))}`);

        if ((hasForbidden && !hasMytilene) || badThess) {
            console.error("🚨 HALLUCINATION DETECTED!");
            reply = "Λυπάμαι, δεν μπορώ να απαντήσω με βεβαιότητα. Επικοινωνήστε με τη Γραμματεία: 22510-36604/22510-36606 ή culturaltec.msc@aegean.gr";
        }

        console.log("🤖 REPLY:", reply.substring(0, 300));
        res.json({ reply });

    } catch (error) {
        console.error("❌ Chat error:", error);
        res.status(500).json({ error: "Server Error" });
    }
});


app.post('/admin/refresh', async (req, res) => {
    const { secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    res.json({ message: "Re-embed ξεκίνησε..." });
    fetchAndEmbedAll(); 
});

app.get('/debug/stats', (req, res) => {
    if (req.query.secret !== process.env.ADMIN_SECRET)
	return res.status(403).json({ error:"Unauthorized" })

    const withEmbedding    = VECTOR_STORE.filter(c => c.embedding && c.embedding.length > 0);
    const withoutEmbedding = VECTOR_STORE.filter(c => !c.embedding || c.embedding.length === 0);

    const byUrl = {};
    VECTOR_STORE.forEach(c => {
        if (!byUrl[c.url]) byUrl[c.url] = { total: 0, withEmbed: 0, title: c.title.replace(/\s*\[\d+\]$/, '') };
        byUrl[c.url].total++;
        if (c.embedding && c.embedding.length > 0) byUrl[c.url].withEmbed++;
    });

    res.json({
        total_chunks:       VECTOR_STORE.length,
        with_embedding:     withEmbedding.length,
        without_embedding:  withoutEmbedding.length,
        by_url:             byUrl
    });
});

app.get('/debug/pdfs', (req, res) => {
    if (req.query.secret !== process.env.ADMIN_SECRET)
	return res.status(403).json({ error:"Unauthorized" })

    const allPdfChunks = VECTOR_STORE.filter(c => c.url && c.url.toLowerCase().includes('.pdf'));

    const byPdf = {};
    allPdfChunks.forEach(c => {
        if (!byPdf[c.url]) byPdf[c.url] = { chunks: 0, title: c.title.replace(/\s*\[\d+\]$/, '') };
        byPdf[c.url].chunks++;
    });

    const filled  = Object.entries(byPdf)
        .filter(([_, v]) => v.chunks >= 2)
        .map(([url, v]) => ({ url, ...v }));

    const suspect = Object.entries(byPdf)
        .filter(([_, v]) => v.chunks === 1)
        .map(([url, v]) => ({ url, ...v }));

    res.json({
        total_pdfs_in_store: Object.keys(byPdf).length,
        ok:      filled,
        suspect: suspect  
    });
});


app.listen(3000, "0.0.0.0", () => console.log('✅ RAG Server (Semantic) Running on :3000'));
