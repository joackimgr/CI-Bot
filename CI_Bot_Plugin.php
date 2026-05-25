<?php
/**
 * Plugin Name: CI Bot - ΠΜΣ Virtual Assistant
 * Description: Ψηφιακός βοηθός για το ΠΜΣ "Πολιτισμική Πληροφορική και Επικοινωνία" του Πανεπιστημίου Αιγαίου. Απαντά σε ερωτήσεις φοιτητών χρησιμοποιώντας τεχνολογία RAG και τοπικό γλωσσικό μοντέλο.
 * Version: 1.0
 * Author: Ioakeim Pantelakis
 */

add_action('rest_api_init', function () {
    register_rest_route('university-chat/v1', '/send', array(
        'methods' => 'POST',
        'callback' => 'handle_chat_request',
        'permission_callback' => '__return_true',
    ));
});

function handle_chat_request($request) {
    error_reporting(0);

    $params = $request->get_json_params();
    $user_message = isset($params['message']) ? $params['message'] : '';
    $history = isset($params['history']) ? $params['history'] : [];

    $vm_url = 'https://ct-swot.aegean.gr/chat';

    $response = wp_remote_post($vm_url, array(
        'headers'     => array('Content-Type' => 'application/json; charset=utf-8'),
        'body'        => json_encode(array(
            'message' => $user_message,
            'history' => $history,
            'model'   => 'gemma3' 
        )),
        'method'      => 'POST',
        'data_format' => 'body',
        'timeout'     => 60
    ));

    if (is_wp_error($response)) {
        return new WP_Error('vm_error', 'Ο Server δεν απαντάει (VM Error)', array('status' => 500));
    }

    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);

    if (ob_get_length()) {
        ob_clean(); 
    }

    return new WP_REST_Response($data, 200);
}

function my_chatbot_inject() {
    ?>
    <style>
        #chatbot-wrapper * { box-sizing: border-box; }
        #chatbot-wrapper { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; z-index: 99999; }

        #chatbot-btn {
            position: fixed; bottom: 25px; right: 25px;
            background: #00457C; color: white; border: none;
            width: 64px; height: 64px; border-radius: 50%;
            cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            transition: transform 0.2s, background 0.2s;
            display: flex; align-items: center; justify-content: center;
            padding: 0; z-index: 99999;
        }
        #chatbot-btn:hover { transform: scale(1.05); background: #003366; }
        #chatbot-btn svg { width: 36px; height: 36px; fill: white; }

        #chatbot-window {
            position: fixed; bottom: 100px; right: 25px;
            width: 360px; height: 520px; background: white;
            border-radius: 16px; box-shadow: 0 5px 25px rgba(0,0,0,0.2);
            display: none; flex-direction: column; overflow: hidden;
            z-index: 99999; border: 1px solid #e0e0e0;
            animation: fadeIn 0.3s ease;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        #chat-header {
            background: linear-gradient(135deg, #00457C, #0056b3);
            color: white; padding: 16px 20px; font-weight: 600;
            display: flex; justify-content: space-between; align-items: center;
        }
        #chat-header .close-btn { cursor: pointer; font-size: 20px; opacity: 0.8; }
        #chat-header .close-btn:hover { opacity: 1; }

        #chat-body {
            flex: 1; padding: 20px; overflow-y: auto; background-color: #f5f7f9;
            display: flex; flex-direction: column; gap: 12px;
        }

        .msg {
            padding: 12px 16px; border-radius: 18px; font-size: 14px; line-height: 1.5;
            max-width: 85%; width: fit-content; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .msg.bot { background: white; color: #333; border-bottom-left-radius: 4px; border: 1px solid #e0e0e0; align-self: flex-start; }
        .msg.user { background: #00457C; color: white; border-bottom-right-radius: 4px; align-self: flex-end; margin-left: auto; }

        .typing-indicator { display: flex; align-items: center; justify-content: center; gap: 5px; padding: 5px 0; min-width: 40px; }
        .typing-dot { width: 6px; height: 6px; background-color: #888; border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both; }
        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }
        @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }

        #chat-footer { padding: 15px; background: white; border-top: 1px solid #eee; display: flex; align-items: center; gap: 10px; }
        #chat-input { flex: 1; padding: 12px 15px; border: 1px solid #ddd; border-radius: 25px; outline: none; background: #f9f9f9; }
        #chat-input:focus { border-color: #00457C; background: white; }
        
        #chat-send {
            background: #00457C; border: none; width: 44px; height: 44px;
            border-radius: 50%; cursor: pointer; display: flex; align-items: center;
            justify-content: center; padding: 0; flex-shrink: 0;
        }
        #chat-send:hover { background: #003366; }
        #chat-send:disabled { background: #ccc; }
        #chat-send svg { width: 20px; height: 20px; fill: white; margin-left: -2px; margin-top: 2px; }
    </style>

    <div id="chatbot-wrapper">
        <button id="chatbot-btn" onclick="toggleChat()">
            <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
        </button>
        
        <div id="chatbot-window">
            <div id="chat-header">
                <span>🎓 CI Bot</span>
                <span class="close-btn" onclick="toggleChat()">✕</span>
            </div>
            <div id="chat-body">
                <div class="msg bot">Γεια σου! Πώς μπορώ να σε βοηθήσω;</div>
            </div>
            <div id="chat-footer">
                <input type="text" id="chat-input" placeholder="Γράψε εδώ..." onkeypress="handleEnter(event)">
                <button id="chat-send" onclick="sendMessage()">
                    <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
            </div>
        </div>
    </div>

    <script>
        const API_URL = "<?php echo get_rest_url(null, 'university-chat/v1/send'); ?>";
        let chatHistory = [];

        function toggleChat() {
            const win = document.getElementById('chatbot-window');
            if (win.style.display === 'none' || win.style.display === '') {
                win.style.display = 'flex';
                setTimeout(() => document.getElementById('chat-input').focus(), 100);
            } else {
                win.style.display = 'none';
            }
        }

        function handleEnter(e) { if (e.key === 'Enter') sendMessage(); }

        let isWaiting = false;

        async function sendMessage() {
            const input = document.getElementById('chat-input');
            const body = document.getElementById('chat-body');
            const btn = document.getElementById('chat-send');
            const txt = input.value.trim();

            if (!txt || isWaiting) return;
            isWaiting = true;
            input.disabled = true;

            body.innerHTML += `<div class="msg user">${escapeHtml(txt)}</div>`;
            input.value = '';
            scrollToBottom();

            btn.disabled = true;
            const loadingId = 'loading-' + Date.now();
            body.insertAdjacentHTML('beforeend', `
                <div class="msg bot" id="${loadingId}">
                    <div class="typing-indicator">
                        <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
                    </div>
                </div>`);
            scrollToBottom();

            try {
                const req = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: txt, history: chatHistory })
                });
                const res = await req.json();
                
                
                if(document.getElementById(loadingId)) {
                    document.getElementById(loadingId).remove();
                }

                if (res.reply) {
                    chatHistory.push({ role: "user", content: txt });
                    chatHistory.push({ role: "assistant", content: res.reply });
                    if (chatHistory.length > 6) chatHistory = chatHistory.slice(-6); 
                    body.innerHTML += `<div class="msg bot">${formatText(res.reply)}</div>`;
                } else {
                    body.innerHTML += `<div class="msg bot">Υπήρξε πρόβλημα στην επικοινωνία.</div>`;
                }
            } catch (err) {
                console.error(err);
                if(document.getElementById(loadingId)) document.getElementById(loadingId).remove();
                body.innerHTML += `<div class="msg bot">Σφάλμα σύνδεσης.</div>`;
            } finally {
                btn.disabled = false;
                isWaiting = false;
                input.disabled = false;
                input.focus();
                scrollToBottom();
            }
        }

        function scrollToBottom() {
            const body = document.getElementById('chat-body');
            body.scrollTop = body.scrollHeight;
        }
        function escapeHtml(text) { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
        function formatText(text) { return text.replace(/\n/g, '<br>'); }
    </script>
    <?php
}
add_action('wp_footer', 'my_chatbot_inject');
?>