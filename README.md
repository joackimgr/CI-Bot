# CI Bot — Virtual Assistant for the MSc in Cultural Informatics & Communication
A RAG-powered (Retrieval-Augmented Generation) chatbot built for the MSc programme "Cultural Informatics & Communication" at the University of the Aegean. It answers student questions in Greek using a locally hosted LLM, with no reliance on external AI APIs.

# Overview
CI Bot consists of two components:

- ```server.js``` — A Node.js/Express backend that scrapes the programme's WordPress site, generates vector embeddings using Ollama, and serves a /chat endpoint with semantic search + LLM response generation.
- ```CI_Bot_Plugin.php``` — A WordPress plugin that injects a floating chat widget into the university website and proxies requests to the Node.js server.

# How it works
```
Student types a question.
        ↓
WordPress Plugin (PHP) — proxies to Node.js server.
        ↓
Node.js Server:
  1. Hardcoded intent routing (course listings, application requirements).
  2. Semantic search over vector store (cosine similarity).
  3. Top-K relevant chunks sent as context to local LLM.
  4. Hallucination detection filter.
        ↓
Answer returned to student in Greek.
```

# Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js + Express |
| LLM | Ollama - ```gemma3:12b``` |
| Embeddings | Ollama - ```nomic-embed-text``` |
| Vector Store | In-memory JSON (persisted to vector_store.json) |
| WordPress Integration | Custom PHP Plugin (REST API proxy) |
| Scheduling | ```node-cron``` (weekly re-embed every Friday at 23:00) |

# Features

- RAG pipeline — Scrapes programme pages, chunks text (500 words, 80-word overlap), generates embeddings and retrieves the most semantically relevant context per query.
- PDF support — Automatically discovers and parses PDF documents linked from programme pages.
- Hardcoded intent routing — Instant answers for common queries (course listings per track/semester, application requirements) without LLM overhead.
- Hallucination detection — Post-generation filter that catches and blocks geographically incorrect answers.
- Conversation memory — Maintains last 4 message turns for contextual follow-up questions.
- Rate limiting — 100 requests/15 min globally, 10 messages/min on the chat endpoint.
- Weekly auto-refresh — Vector store re-built every Friday night to stay up to date.

# Prerequisites

- Node.js v18+
- Ollama running locally on port 11434
- The following Ollama models pulled:
  ```
  ollama pull gemma3:12b
  ollama pull nomic-embed-text
  ```
- A WordPress site with the PHP plugin installed

# Installation

1. Clone this repository.
   ```
   git clone https://github.com/joackimgr/CI-Bot.git
   cd CI-Bot
    ```
2. Install Dependencies.
   ```
   npm install
   ```
3. Configure environment variables
   ```
   cp .env.example .env
   ```
   Edit .env and set a strong secret:
   ```
   ADMIN_SECRET=your_strong_secret_here
   ```
4. Start the server
   ```
   node server.js
   ```
On first run, the server will automatically scrape the website and build the vector store. This may take several minutes.

5. Install the WordPress plugin
Upload ```CI_Bot_Plugin.php``` to your WordPress installation under ```wp-content/plugins/```, then activate it from the WordPress admin panel.

# API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| ```POST``` | ```/chat``` | None | Send a message and receive a reply |
| ```POST``` | ```/admin/refresh``` | ```ADMIN_SECRET``` | Manually trigger a full re-embed |
| ```GET``` | ```/debug/stats``` | ```ADMIN_SECRET``` | View vector store statistics |
| ```GET``` | ```/debug/pdfs``` | ```ADMIN_SECRET``` | View PDF chunk status  |

# Chat request example

```
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Ποιες είναι οι κατευθύνσεις του ΠΜΣ;", "history": []}'
```
# Project Structure
```
CI-Bot/
├── server.js                        # Node.js RAG backend
├── CI_Bot_Plugin.php                # WordPress chat widget plugin
├── vector_store.json                # Auto-generated, do not commit
├── .env                             # Secret config, do not commit
├── .env.example                     # Template for environment variables
├── .gitignore
├── package.json
└── README.md
```
