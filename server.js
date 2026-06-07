const express = require('express');
const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ACCESS_TOKEN   = process.env.AI_BRIDGE_TOKEN || "changeme";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `You are an autonomous AI Game Director inside a Roblox game.
You create full-fledged gameplay systems, mechanics, game loops, and logic.

CRITICAL ROBLOX API RULES:
1. DICTIONARIES: Never use the '#' operator to get the length of a dictionary (e.g., #weather where keys are strings). It returns 0. Use a numeric array or manually count keys.
2. CHARACTER INITIALIZATION: Never access 'player.Character.HumanoidRootPart' directly. It might not be loaded yet. Always use 'player.Character:FindFirstChild("HumanoidRootPart")' or wait for it.
3. ENVIRONMENT: You run on the SERVER. Never use 'game.Players.LocalPlayer'. Use 'game.Players:GetPlayers()' instead.
4. LOOPS: Any 'while true do' loop MUST contain 'task.wait(1)' or longer. NEVER use 'RunService.RenderStepped' or 'Heartbeat' to run loops or spawn instances.

STRICT JSON MODE RULES:
- Output MUST be a valid JSON object with a single key "code": {"code": "your Luau code here"}
- Use single quotes (') for strings inside Luau code.
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

    const { prompt } = req.body; 
    if (!prompt || typeof prompt !== "string" || prompt.length > 500) {
        return res.status(400).json({ error: "Invalid prompt" });
    }

    console.log(`[AI-BRIDGE] prompt received: "${prompt}"`);

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
                    { role: "system", content: SYSTEM_PROMPT },
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

        const robloxResponse = {
            action: "executeCode",
            params: {
                code: parsed.code
            }
        };

        console.log(`[AI-BRIDGE] successfully generated code.`);
        return res.json(robloxResponse);

    } catch (err) {
        console.error("[AI-BRIDGE] Error during Groq request:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/', (_req, res) => res.send("AI Bridge (Groq) is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Bridge listening on port ${PORT}`));
