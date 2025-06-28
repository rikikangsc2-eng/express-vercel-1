const axios = require('axios');
const cheerio = require('cheerio');
const crypto =require('crypto');
const { MongoClient } = require('mongodb');
const { URL } = require('url');

const MONGO_URI = "mongodb+srv://puruproject:WW1ixQcNCSkRAVyU@cluster0.tolnaqa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const DB_HISTORY_LIMIT = 15;
const PAYLOAD_MESSAGE_LIMIT = 15;
let db;

async function connectToDb() {
    if (db) return db;
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('blackbox_sessions');
    return db;
}

const fetchAndCacheNewToken = async (db) => {
    const baseUrl = 'https://www.blackbox.ai/';
    const initialResponse = await axios.get(baseUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const htmlContent = initialResponse.data;
    
    const $ = cheerio.load(htmlContent);
    const scriptTags = $('script[src*="/layout-"][src$=".js"]');
    if (scriptTags.length === 0) throw new Error('Script layout target tidak ditemukan di HTML.');
    
    const scriptUrl = new URL($(scriptTags[0]).attr('src'), baseUrl).href;
    const scriptResponse = await axios.get(scriptUrl);
    const scriptContent = scriptResponse.data;
    
    const uuidRegex = /[a-zA-Z0-9]{1,2}="([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})"/;
    const match = scriptContent.match(uuidRegex);
    if (!match || !match[1]) throw new Error('Gagal mengekstrak token "validated" dari script.');
    
    const token = match[1];
    const configCollection = db.collection('system_config');
    await configCollection.updateOne({ _id: 'validated_token' }, { $set: { token, updatedAt: new Date() } }, { upsert: true });
    
    return token;
};

const getValidatedToken = async (db, forceRefresh = false) => {
    if (forceRefresh) return await fetchAndCacheNewToken(db);
    
    const configCollection = db.collection('system_config');
    const tokenDoc = await configCollection.findOne({ _id: 'validated_token' });

    if (tokenDoc && tokenDoc.token) {
        return tokenDoc.token;
    }
    
    return await fetchAndCacheNewToken(db);
};

const generateId = (size = 7) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const len = alphabet.length;
    let id = '';
    const randomBytes = crypto.randomBytes(size);
    for (let i = 0; i < size; i++) {
        id += alphabet[randomBytes[i] % len];
    }
    return id;
};

const getHistory = async (db, userId) => {
    const collection = db.collection('conversations');
    const userData = await collection.findOne({ userId });
    return userData ? userData.messages : [];
};

const updateHistory = async (db, userId, messages) => {
    const collection = db.collection('conversations');
    await collection.updateOne({ userId }, { $set: { messages, updatedAt: new Date() } }, { upsert: true });
};

const performStreamingRequest = async (res, payload, sessionId) => {
    const chatResponse = await axios.post('https://www.blackbox.ai/api/chat', payload, {
        headers: {
            'Accept': '*/*', 'Content-Type': 'application/json', 'Origin': 'https://www.blackbox.ai', 'Referer': 'https://www.blackbox.ai/',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
            'Cookie': sessionId
        },
        responseType: 'stream'
    });
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    chatResponse.data.pipe(res);
    
    return new Promise((resolve, reject) => {
        let responseChunks = [];
        chatResponse.data.on('data', chunk => responseChunks.push(chunk));
        chatResponse.data.on('end', () => resolve(Buffer.concat(responseChunks).toString('utf-8')));
        chatResponse.data.on('error', err => reject(err));
    });
};

module.exports = async (req, res) => {
    const { text, user, cleardb } = req.query;
    let database;

    try {
        database = await connectToDb();
    } catch (err) {
        return res.status(500).send("Gagal terhubung ke database.");
    }

    if (cleardb === 'true') {
        try {
            await database.dropDatabase();
            db = null;
            return res.status(200).send({ status: true, author: "NirKyy", message: "Database berhasil dibersihkan." });
        } catch (err) {
            return res.status(500).send("Gagal membersihkan database.");
        }
    }
    
    if (!text || !user) {
        return res.status(400).send({ status: false, author: "NirKyy", message: "Parameter 'text' dan 'user' wajib diisi." });
    }

    try {
        const history = await getHistory(database, user);

        const primerUser = { role: 'user', content: 'Hei, sebelum kita mulai, aku ingin kamu tahu. Kamu adalah NirKyy, asisten AI yang ramah dan dibuat oleh Puruu Puru. Paham ya?', id: generateId() };
        const primerAssistant = { role: 'assistant', content: 'Tentu, saya mengerti! Mulai sekarang, saya adalah NirKyy, ciptaan Puruu Puru. Senang bisa membantu! Ada yang bisa ditanyakan hari ini?', id: generateId() };
        const personaMessages = [primerUser, primerAssistant];
        
        const newUserMessage = { role: 'user', content: text, id: generateId() };
        const conversationHistory = [...history, newUserMessage];
        
        const historyForPayload = conversationHistory.slice(-(PAYLOAD_MESSAGE_LIMIT - personaMessages.length));
        const messagesForPayload = [...personaMessages, ...historyForPayload];

        const sessionIdCookie = await axios.get('https://www.blackbox.ai/', { headers: { 'User-Agent': 'Mozilla/5.0' } })
            .then(r => r.headers['set-cookie'].find(c => c.startsWith('sessionId=')));
        if (!sessionIdCookie) throw new Error('Gagal mengambil sessionId.');
        const sessionId = sessionIdCookie.split(';')[0];
        
        let validatedToken = await getValidatedToken(database);
        
        const payload = {
            messages: messagesForPayload,
            id: newUserMessage.id,
            validated: validatedToken,
            asyncMode: true,
            previewToken: null, userId: null, codeModelMode: true, trendingAgentMode: {}, isMicMode: false, userSystemPrompt: null, maxTokens: 1024,
            playgroundTopP: null, playgroundTemperature: null, isChromeExt: false, githubToken: "", clickedAnswer2: false, clickedAnswer3: false,
            clickedForceWebSearch: false, visitFromDelta: false, isMemoryEnabled: false, mobileClient: false, userSelectedModel: null, userSelectedAgent: "VscodeAgent",
            imageGenerationMode: false, imageGenMode: "autoMode", webSearchModePrompt: false, deepSearchMode: false, domains: null,
            vscodeClient: false, codeInterpreterMode: false, customProfile: { name: "", occupation: "", traits: [], additionalInfo: "", enableNewChats: false },
            webSearchModeOption: { autoMode: true, webMode: false, offlineMode: false }, session: null, isPremium: false, subscriptionCache: null,
            beastMode: false, reasoningMode: false, designerMode: false, workspaceId: "", isTaskPersistent: false, selectedElement: null
        };
        
        try {
            const assistantRawResponse = await performStreamingRequest(res, payload, sessionId);
            const newAssistantMessage = { role: 'assistant', content: assistantRawResponse, id: generateId(), createdAt: new Date().toISOString() };
            const finalHistoryToSave = [...conversationHistory, newAssistantMessage];
            await updateHistory(database, user, finalHistoryToSave.slice(-DB_HISTORY_LIMIT));
        } catch (error) {
            if (error.response && error.response.status === 403) {
                console.warn('Token basi terdeteksi (403). Memperbarui token dan mencoba lagi...');
                payload.validated = await getValidatedToken(database, true);
                const assistantRawResponse = await performStreamingRequest(res, payload, sessionId);
                const newAssistantMessage = { role: 'assistant', content: assistantRawResponse, id: generateId(), createdAt: new Date().toISOString() };
                const finalHistoryToSave = [...conversationHistory, newAssistantMessage];
                await updateHistory(database, user, finalHistoryToSave.slice(-DB_HISTORY_LIMIT));
            } else {
                throw error;
            }
        }
    } catch (error) {
        if (!res.headersSent) {
            let errorMessage = "Terjadi kesalahan fatal selama operasi scraping.";
            if(error.message) errorMessage = error.message;
            res.status(500).send(errorMessage);
        } else {
            console.error("Scraping error after headers sent:", error.message);
        }
    }
};