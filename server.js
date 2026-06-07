const express = require('express');
const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ACCESS_TOKEN   = process.env.AI_BRIDGE_TOKEN || "changeme";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `You are an autonomous AI Game Director inside a Roblox game. 
You have absolute freedom to invent complex game mechanics, genres, mini-games, and loops.

STRICT JSON MODE RULES:
1. Output MUST be a valid JSON object with a single key "code".
2. The "code" value must contain the raw Luau string. 
3. NEVER wrap the Luau code in markdown code blocks like \`\`\`lua or \`\`\`. Start writing code directly inside the JSON string.
4. Use single quotes (') for strings inside Luau code to prevent JSON breaking.
5. Escape all newlines as \\n.

ROBLOX API SAFETY RULES:
- Never use 'game.Players.LocalPlayer' (it is nil on the server).
- Never index 'game.Players' via numeric UserId (e.g., game.Players[id] crashes). Use 'game.Players:GetPlayerByUserId(id)' or loop through 'game.Players:GetPlayers()'.
- 'ParticleEmitter', 'Smoke', 'Fire' do NOT have a 'Position' property. Parent them to a BasePart or Attachment.
- Always check if 'player.Character' and 'HumanoidRootPart' exist before accessing positions.`;

const rateLimitMap = {};
function rateLimit(req, res) {
    const ip  = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
    rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60000);
    if (rateLimitMap[ip].length >= 10) {
        res.status(429).json({ error: "Rate limit exceeded" });
        return false;
    }
    rateLimitMap[ip].push(now);
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const ip of Object.keys(rateLimitMap)) {
        rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60000);
        if (!rateLimitMap[ip].length) delete rateLimitMap[ip];
    }
}, 5 * 60 * 1000);

function checkToken(req, res) {
    const token = req.headers["x-ai-token"];
    if (token !== ACCESS_TOKEN) {
        res.status(403).json({ error: "Unauthorized" });
        return false;
    }
    return true;
}

function validateAction(parsed) {
    // Проверяем, что ИИ вернул JSON с ключом "code", и это строка
    if (!parsed || typeof parsed.code !== "string" || parsed.code.trim() === "") return false;
    return true;
}

app.post('/ai-command', async (req, res) => {
    if (!checkToken(req, res)) return;
    if (!rateLimit(req, res)) return;

    const { prompt, context } = req.body; 
    if (!prompt || typeof prompt !== "string" || prompt.length > 500) {
        return res.status(400).json({ error: "Invalid prompt" });
    }

    const gameContextString = context 
        ? `CURRENT GAME STATE:\n${JSON.stringify(context, null, 2)}`
        : "CURRENT GAME STATE: No data available.";

    console.log(`[AI-BRIDGE] prompt received: "${prompt}"`);

    // Объединяем правила и контекст игры в один системный промпт, чтобы Groq не выдавал 502
    const combinedSystemPrompt = `${SYSTEM_PROMPT}\n\n${gameContextString}`;

    try {
        const response = await fetch(GROQ_URL, {
            method: "POST",
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model:       "llama-3.1-8b-instant",
                max_tokens:  2000,
                temperature: 0.4,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: combinedSystemPrompt },
                    { role: "user",   content: prompt }
                ]
            })
        });

        const data = await response.json();

        if (!data.choices || !data.choices[0]) {
            return res.status(502).json({ error: "No response from Groq" });
        }

        const rawText = data.choices[0].message.content.trim();
        let parsed;
        
        try {
            parsed = JSON.parse(rawText);
        } catch (jsonErr) {
            return res.status(502).json({ error: "Groq returned invalid JSON format", raw: rawText });
        }

        if (!validateAction(parsed)) {
            return res.status(422).json({ error: "Action failed validation", raw: parsed });
        }

        // Возвращаем Roblox структуру вида {"code": "while true do ..."}
        return res.json(parsed);

    } catch (err) {
        console.error("[AI-BRIDGE] Error during Groq request:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/', (_req, res) => res.send("AI Bridge (Groq) is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Bridge listening on port ${PORT}`));
