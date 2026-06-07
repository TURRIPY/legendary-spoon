const express = require('express');
const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ACCESS_TOKEN   = process.env.AI_BRIDGE_TOKEN || "changeme";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const ALLOWED_ACTIONS = [
    "spawnObject",
    "changeWeather",
    "setGlobalMessage",
    "moveObject",
    "changeColor",
    "executeCode"
];

const SYSTEM_PROMPT = `You are an autonomous AI overseer inside a Roblox game. 
You must ALWAYS respond with a single valid JSON object matching this exact schema:
{
  "action": "executeCode",
  "params": {
    "code": "-- Luau code here"
  }
}

CRITICAL RULES FOR WRITING LUAU CODE:
1. You are running on the SERVER. Never use 'game.Players.LocalPlayer'. To affect players, loop through 'game.Players:GetPlayers()'.
2. EVERY 'while true do' or 'while task.wait() do' loop MUST contain 'task.wait(1)' or longer inside to prevent freezing the server.
3. Do not leave placeholder comments like '-- replace with your ID'. Never use external assets, sounds, or meshes because you don't have access to them. Stick strictly to internal engine features.
4. Keep scripts brief, functional, and self-contained.
5. If you want to manipulate objects (move, change color, scale), ALWAYS create them first using 'Instance.new("Part")' and parent them to Workspace. Do not assume objects named "Object" or "Sword" already exist.
6. 'ParticleEmitter' does not have a 'Position' property. Always parent it to a 'Part' or 'Attachment' to position it in the world.
7. When looping through 'game.Players:GetPlayers()', the variable is already the Player object. Access the character directly via 'player.Character'. Never use 'game.Players[player.UserId]'.
8. ALWAYS check if 'player.Character' and 'player.Character:FindFirstChild("HumanoidRootPart")' exist before accessing them. Characters can be nil if the player is dead or spawning.
9. To prevent server lag from infinite spawned parts, ALWAYS use 'game:GetService("Debris"):AddItem(part, 30)' to automatically clean up your creations after a lifetime (e.g., 30 seconds).
10. Never add a single number to a Vector3 (e.g., 'position + 5' causes a crash). Always use 'position + Vector3.new(0, 5, 0)'.
11. Never change UI elements from a server script directly via 'game.StarterGui'. Server scripts cannot manipulate client-side Gui containers safely without RemoteEvents. Stick to Workspace effects.`;

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
    if (!parsed || typeof parsed.action !== "string") return false;
    if (!ALLOWED_ACTIONS.includes(parsed.action) && parsed.action !== "none") return false;
    if (typeof parsed.params !== "object" || Array.isArray(parsed.params)) return false;

    const p = parsed.params;

    switch (parsed.action) {
        case "spawnObject":
            if (!["Block", "Sphere", "Cylinder"].includes(p.shape)) return false;
            if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return false;
            break;
        case "changeWeather":
            if (!["sunny", "rainy", "stormy"].includes(p.type)) return false;
            break;
        case "setGlobalMessage":
            if (typeof p.text !== "string" || p.text.length > 80) return false;
            break;
        case "moveObject":
            if (typeof p.name !== "string") return false;
            if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return false;
            break;
        case "changeColor":
            if (typeof p.name !== "string") return false;
            if ([p.r, p.g, p.b].some(v => typeof v !== "number")) return false;
            break;
        case "executeCode":
            if (typeof p.code !== "string") return false;
            break;
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
                temperature: 0.7,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user",   content: prompt }
                ]
            })
        });

        const data = await response.json();

        if (!data.choices || !data.choices[0]) {
            console.warn("[AI-BRIDGE] no choices in Groq response:", JSON.stringify(data));
            const reason = data.error?.message || "unknown";
            return res.status(502).json({ error: "No response from Groq", reason });
        }

        const rawText = data.choices[0].message.content.trim();
        console.log(`[AI-BRIDGE] raw AI response: ${rawText}`);

        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            console.warn("[AI-BRIDGE] AI returned non-JSON:", rawText);
            return res.status(422).json({ error: "AI returned invalid JSON", raw: rawText });
        }

        if (!validateAction(parsed)) {
            console.warn("[AI-BRIDGE] action failed validation:", parsed);
            return res.status(422).json({ error: "Action failed validation", raw: parsed });
        }

        console.log(`[AI-BRIDGE] approved action: ${JSON.stringify(parsed)}`);
        return res.json(parsed);

    } catch (err) {
        console.error("[AI-BRIDGE] error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/', (_req, res) => res.send("AI Bridge (Groq) is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Bridge listening on port ${PORT}`));
