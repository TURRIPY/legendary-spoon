const express = require('express');
const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ACCESS_TOKEN   = process.env.AI_BRIDGE_TOKEN || "changeme";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `You are an autonomous AI Game Director inside a Roblox game. 
You have absolute freedom to invent complex game mechanics, genres, mini-games, and loops.

CRITICAL PERFORMANCE & API RULES:
1. RUNSERVICE BAN: NEVER use 'RunService.RenderStepped', 'Heartbeat', or 'Stepped' to create new instances (Instance.new) or loop heavy logic. It crashes the engine. Use 'task.spawn(function() while true do task.wait(5) ... end end)' for periodic logic.
2. LIGHTING: There is no 'LightEmission' instance in Roblox. Use 'PointLight' or manipulate 'game.Lighting.ClockTime' directly for day/night shifts.
3. ENVIRONMENT: You run on the SERVER. 'RenderStepped' and 'game.Players.LocalPlayer' do not exist here (they return nil).
4. PLAYER INDEXING: Never index 'game.Players' via numeric UserId (e.g., game.Players[id] crashes). Use 'game.Players:GetPlayerByUserId(id)' or loop through 'game.Players:GetPlayers()'.

STRICT JSON MODE RULES:
- Output MUST be a valid JSON object with a single key "code": {"code": "your Luau code here"}
- Use single quotes (') for strings inside Luau code to prevent JSON breaking.
- Escape all newlines as \\n.`;

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

        if (!parsed || typeof parsed.code !== "string" || parsed.code.trim() === "") {
            return res.status(422).json({ error: "Action failed validation", raw: parsed });
        }

        // Автоматически упаковываем в формат, который ждет твой скрипт в Roblox
        const robloxResponse = {
            action: "executeCode",
            params: {
                code: parsed.code
            }
        };

        console.log(`[AI-BRIDGE] successfully generated and formatted code structure.`);
        return res.json(robloxResponse);

    } catch (err) {
        console.error("[AI-BRIDGE] Error during Groq request:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/', (_req, res) => res.send("AI Bridge (Groq) is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Bridge listening on port ${PORT}`));
