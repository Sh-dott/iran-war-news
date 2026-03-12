require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const RSSParser = require('rss-parser');
const { translate } = require('google-translate-api-x');
const { MongoClient } = require('mongodb');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// =============================================
// SECURITY MIDDLEWARE
// =============================================

// Security headers (CSP allows inline scripts/styles needed by the app)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https://www.google.com", "https://*.gstatic.com", "https://flagcdn.com"],
            connectSrc: ["'self'"],
        }
    },
    crossOriginEmbedderPolicy: false,
}));

// General rate limit: 100 requests per minute per IP
const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', generalLimiter);

// Strict rate limit on refresh: 3 per 5 minutes per IP
const refreshLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Refresh rate limited. Please wait a few minutes.' }
});
app.use('/api/refresh', refreshLimiter);
const PORT = process.env.PORT || 3000;
const parser = new RSSParser({
    timeout: 10000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    }
});

// =============================================
// RSS FEED SOURCES
// =============================================
const FEEDS = {
    'iran-state': [
        { name: 'Press TV', url: 'https://www.presstv.ir/RSS', lang: 'en', country: '🇮🇷' },
        { name: 'IRNA', url: 'https://en.irna.ir/rss', lang: 'en', country: '🇮🇷' },
        { name: 'Mehr News', url: 'https://en.mehrnews.com/rss', lang: 'en', country: '🇮🇷' },
        { name: 'Tehran Times', url: 'https://www.tehrantimes.com/rss', lang: 'en', country: '🇮🇷' },
        { name: 'Fars News', url: 'https://en.farsnews.ir/rss', lang: 'en', country: '🇮🇷' },
        { name: 'Iran Press', url: 'https://iranpress.com/rss', lang: 'en', country: '🇮🇷' },
        { name: 'Tasnim News', url: 'https://www.tasnimnews.com/en/rss', lang: 'en', country: '🇮🇷' },
    ],
    'iran-independent': [
        { name: 'Iran International', url: 'https://www.iranintl.com/en/feed', lang: 'en', country: '🇮🇷' },
        { name: 'IranWire', url: 'https://iranwire.com/en/feed/', lang: 'en', country: '🇮🇷' },
        { name: 'Radio Farda', url: 'https://en.radiofarda.com/api/zrqiteuuir', lang: 'en', country: '🇮🇷' },
        { name: 'Kayhan Life', url: 'https://kayhanlife.com/feed/', lang: 'en', country: '🇮🇷' },
        { name: 'Iran News Daily', url: 'https://irannewsdaily.com/feed/', lang: 'en', country: '🇮🇷' },
    ],
    'arabic': [
        { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', lang: 'en', country: '🇶🇦' },
        { name: 'Middle East Eye', url: 'https://www.middleeasteye.net/rss', lang: 'en', country: '🇬🇧' },
        { name: 'Al Arabiya', url: 'https://english.alarabiya.net/tools/rss', lang: 'en', country: '🇸🇦' },
        { name: 'Al-Monitor', url: 'https://www.al-monitor.com/rss', lang: 'en', country: '🇺🇸' },
    ],
    'western': [
        { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', lang: 'en', country: '🇬🇧' },
        { name: 'CNN', url: 'http://rss.cnn.com/rss/edition_meast.rss', lang: 'en', country: '🇺🇸' },
        { name: 'NPR', url: 'https://feeds.npr.org/1004/rss.xml', lang: 'en', country: '🇺🇸' },
        { name: 'France 24', url: 'https://www.france24.com/en/middle-east/rss', lang: 'en', country: '🇫🇷' },
        { name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-world', lang: 'en', country: '🇩🇪' },
        { name: 'The Guardian', url: 'https://www.theguardian.com/world/iran/rss', lang: 'en', country: '🇬🇧' },
        { name: 'PBS', url: 'https://www.pbs.org/newshour/feeds/rss/world', lang: 'en', country: '🇺🇸' },
    ],
    'israeli': [
        { name: 'Jerusalem Post', url: 'https://www.jpost.com/rss/rssfeedsmiddleeast', lang: 'en', country: '🇮🇱' },
        { name: 'JPost - Iran', url: 'https://www.jpost.com/rss/rssfeedsiran', lang: 'en', country: '🇮🇱' },
        { name: 'JPost - Defense', url: 'https://www.jpost.com/rss/rssfeeddefense-and-tech', lang: 'en', country: '🇮🇱' },
        { name: 'JPost - Breaking', url: 'https://www.jpost.com/rss/rssfeedsheadlines.aspx', lang: 'en', country: '🇮🇱' },
        { name: 'Times of Israel', url: 'https://www.timesofisrael.com/feed/', lang: 'en', country: '🇮🇱' },
        { name: 'Ynetnews', url: 'https://www.ynetnews.com/RSS/5.xml', lang: 'en', country: '🇮🇱' },
        { name: 'Ynet חדשות', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml', lang: 'he', country: '🇮🇱' },
        { name: 'Ynet מבזקים', url: 'https://www.ynet.co.il/Integration/StoryRss1854.xml', lang: 'he', country: '🇮🇱' },
        { name: 'i24 News', url: 'https://www.i24news.tv/en/rss', lang: 'en', country: '🇮🇱' },
        { name: 'Haaretz', url: 'https://www.haaretz.com/srv/haaretz-latest-headlines', lang: 'en', country: '🇮🇱' },
        { name: 'Haaretz - Middle East', url: 'https://www.haaretz.com/srv/middle-east-news-rss', lang: 'en', country: '🇮🇱' },
        { name: 'Israel Hayom', url: 'https://www.israelhayom.co.il/rss.xml', lang: 'he', country: '🇮🇱' },
        { name: 'Maariv', url: 'https://www.maariv.co.il/Rss/RssChadashot', lang: 'he', country: '🇮🇱' },
        { name: 'Walla', url: 'https://rss.walla.co.il/feed/1', lang: 'he', country: '🇮🇱' },
        { name: 'Arutz Sheva', url: 'https://www.israelnationalnews.com/Rss.aspx?act=.1', lang: 'en', country: '🇮🇱' },
        { name: 'JNS', url: 'https://www.jns.org/feed/', lang: 'en', country: '🇮🇱' },
        { name: 'IDF Official', url: 'https://www.idf.il/en/rss/', lang: 'en', country: '🇮🇱' },
        { name: 'Alma Center', url: 'https://israel-alma.org/feed/', lang: 'en', country: '🇮🇱' },
        { name: 'INSS', url: 'https://www.inss.org.il/feed/', lang: 'en', country: '🇮🇱' },
    ],
    'telegram': [
        { name: 'Telegram - IDF', url: 'https://rsshub.app/telegram/channel/idfofficial', lang: 'he', country: '🇮🇱' },
        { name: 'Telegram - Israel Today', url: 'https://rsshub.app/telegram/channel/ILtoday', lang: 'he', country: '🇮🇱' },
        { name: 'Telegram - Abu Ali Express', url: 'https://rsshub.app/telegram/channel/AbuAliExpress', lang: 'he', country: '🇮🇱' },
        { name: 'Telegram - Hananya Naftali', url: 'https://rsshub.app/telegram/channel/hnaftali', lang: 'en', country: '🇮🇱' },
        { name: 'Google News - Iran War', url: 'https://news.google.com/rss/search?hl=en&gl=US&q=iran+war+israel+2026&ceid=US:en', lang: 'en', country: '' },
        { name: 'Google News - Iran War HE', url: 'https://news.google.com/rss/search?hl=iw&gl=IL&q=%D7%9E%D7%9C%D7%97%D7%9E%D7%94+%D7%90%D7%99%D7%A8%D7%9F&ceid=IL:he', lang: 'he', country: '🇮🇱' },
        { name: 'UN News - Middle East', url: 'https://news.un.org/feed/subscribe/en/news/region/middle-east/feed/rss.xml', lang: 'en', country: '' },
        { name: 'Middle East Monitor', url: 'https://www.middleeastmonitor.com/feed/', lang: 'en', country: '🇬🇧' },
    ],
};

// Core keywords — article matches if ANY of these appear (must be specific to Iran war)
const CORE_KEYWORDS = [
    'iran war', 'iran conflict', 'iran strike', 'iran attack',
    'iranian', 'tehran', 'isfahan', 'tabriz', 'shiraz',
    'khamenei', 'mojtaba', 'irgc', 'revolutionary guard', 'quds force',
    'hezbollah', 'hezballah', 'hizbullah',
    'natanz', 'fordow',
    'strait of hormuz',
    'houthi',
    'centcom',
    'epic fury', 'roaring lion', 'operation rising lion',
    // Hebrew core keywords
    'איראן', 'טהרן', 'חיזבאללה', 'חות\'ים', 'משמרות המהפכה', 'צבא ארה"ב',
    'שאגת הארי', 'אפיק פיורי',
];

// Context keywords — only match when combined with a region keyword
const CONTEXT_KEYWORDS = [
    'war', 'strike', 'attack', 'bomb', 'raid', 'airstrike', 'airstrikes',
    'casualt', 'killed', 'dead', 'wounded',
    'operation', 'missile', 'drone', 'ballistic',
    'sanction', 'ceasefire', 'surrender', 'negotiat',
    'nuclear', 'enrichment',
    'oil price', 'crude oil',
    'pentagon', 'trump iran', 'trump war', 'trump strike',
    'proxy', 'militia',
    'תקיפה', 'מלחמה', 'הפצצה', 'טיל', 'רחפן',
];

// Region keywords — used to validate context keyword matches
const REGION_KEYWORDS = [
    'iran', 'israel', 'lebanon', 'beirut', 'tehran', 'syria', 'iraq',
    'middle east', 'mideast', 'idf', 'netanyahu', 'gallant', 'hezbollah', 'houthi',
    'איראן', 'ישראל', 'לבנון', 'סוריה', 'עיראק',
];

// Hebrew-specific core keywords — immediate pass for Hebrew sources (must be WAR-specific, not just country names)
const HEBREW_CORE_KEYWORDS = [
    // War-specific compound phrases — these are unambiguous
    'תקיפה באיראן', 'תקיפה בטהרן', 'תקיפה בלבנון', 'תקיפה בסוריה',
    'מלחמה עם איראן', 'מלחמה באיראן', 'המלחמה באיראן',
    'הפצצה באיראן', 'הפצצה בלבנון', 'הפצצה בסוריה',
    'שאגת הארי', 'אפיק פיורי', 'מבצע שאגת',
    'החזית הצפונית',
    // Specific entities that only appear in war context
    'חמינאי', 'מוג\'תבא', 'משמרות המהפכה', 'כוח קודס', 'פאסדראן',
    'חיזבאללה', 'חיזבללה',
    'חות\'ים', 'חותים', 'אנסאר אללה',
    'סנטקום',
    'נתנז', 'פורדו', 'צנטריפוגות',
    'מצר הורמוז',
    'טיל בליסטי', 'טילים בליסטיים',
];

// Hebrew keywords that need context (region/war) — too broad on their own
const HEBREW_CONTEXT_KEYWORDS = [
    'איראן', 'אירן', 'טהרן', 'איספהאן',
    'גרעין', 'העשרה',
    'צבא ארה"ב', 'פנטגון',
    'טילים', 'רחפנים',
    'המפרץ הפרסי',
];

// Hebrew region keywords — for two-tier matching (WITHOUT 'ישראל' which is meaningless for Hebrew Israeli sources)
const HEBREW_REGION_KEYWORDS = [
    'איראן', 'לבנון', 'ביירות', 'סוריה', 'עיראק', 'תימן',
    'חיזבאללה', 'חות\'ים',
];

// Hebrew exclude keywords — reject if these appear without a core keyword (local crime/accidents/culture)
const HEBREW_EXCLUDE_KEYWORDS = [
    'רצח', 'חשוד', 'חשודה', 'משטרה', 'פלילי', 'פלילית',
    'תאונת דרכים', 'שוד', 'גניבה', 'סמים',
    'בית משפט', 'כתב אישום', 'מעצר', 'ערעור', 'תובעים', 'נאשם',
    'תאונה', 'שריפה',
    'אוסקר', 'סרט', 'דוקודרמה', 'פסטיבל', 'קולנוע', 'סדרה',
    'כדורגל', 'כדורסל', 'ספורט', 'אולימפי', 'מונדיאל',
    'מגן אנושי', 'קולו של',
    'ראפר', 'זמר', 'זמרת', 'להקה', 'מוזיקה', 'אלבום', 'שיר',
    'בדיקת מהירות', 'תנועה', 'דוח תנועה',
    'מזג אוויר', 'תחזית',
    'בורסה', 'מניות', 'ביטקוין', 'קריפטו',
    'נדל"ן', 'דירות', 'שיווק דירות', 'קרקעות', 'משכנתא', 'בנייה', 'קבלן',
    'סינדרלה', 'ירוחם', 'דימונה',
    'מתכון', 'בישול', 'אופנה', 'לייף סטייל',
    'הורוסקופ', 'מזל',
];

// English exclude keywords — reject if these appear without a DIRECT Iran/war core keyword
const ENGLISH_EXCLUDE_KEYWORDS = [
    'oscar', 'film', 'movie', 'documentary', 'docudrama', 'cinema', 'festival', 'grammy', 'emmy',
    'football', 'soccer', 'basketball', 'sports', 'olympic', 'world cup', 'fifa', 'nba', 'nfl',
    'cookbook', 'recipe', 'fashion', 'celebrity', 'entertainment', 'album', 'rapper', 'singer',
    'human shield', 'hamas documentary',
    'court ruling', 'lawsuit', 'trial', 'appeal', 'prosecution', 'defendant', 'verdict',
    'stock market', 'bitcoin', 'crypto', 'earnings report',
    'weather forecast', 'traffic',
    'kneecap',
];

function isIranWarRelevant(text, lang) {
    const lower = text.toLowerCase();

    if (lang === 'he') {
        // Hebrew path: use Hebrew-specific arrays
        const hasExclude = HEBREW_EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));

        // 1. Hebrew war-specific core keywords → pass (even with exclude, these are unambiguous)
        if (HEBREW_CORE_KEYWORDS.some(kw => lower.includes(kw))) return true;

        // If exclude keyword present, reject (court cases, music, sports, etc.)
        if (hasExclude) return false;

        // 2. Hebrew context keywords (איראן, טהרן, etc.) + war/military context → pass
        if (HEBREW_CONTEXT_KEYWORDS.some(kw => lower.includes(kw))) {
            const hasWarContext = CONTEXT_KEYWORDS.some(kw => lower.includes(kw)) ||
                                 HEBREW_REGION_KEYWORDS.some(kw => lower.includes(kw));
            if (hasWarContext) return true;
        }

        // 3. Context + Hebrew region (no 'ישראל') → pass
        const hasContext = CONTEXT_KEYWORDS.some(kw => lower.includes(kw));
        if (hasContext && HEBREW_REGION_KEYWORDS.some(kw => lower.includes(kw))) return true;

        // 4. English core keywords (mixed-lang content) → pass
        if (CORE_KEYWORDS.some(kw => lower.includes(kw))) return true;

        return false;
    }

    // English path
    const hasEnExclude = ENGLISH_EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));
    if (hasEnExclude) {
        // Only pass if it has a DIRECT war-specific keyword (not just "iran" mentioned in passing)
        const directCore = ['iran war', 'iran conflict', 'iran strike', 'iranian', 'tehran',
                            'hezbollah', 'houthi', 'irgc', 'khamenei', 'epic fury', 'roaring lion', 'centcom'];
        return directCore.some(kw => lower.includes(kw));
    }
    if (CORE_KEYWORDS.some(kw => lower.includes(kw))) return true;
    const hasContext = CONTEXT_KEYWORDS.some(kw => lower.includes(kw));
    if (hasContext) {
        return REGION_KEYWORDS.some(kw => lower.includes(kw));
    }
    return false;
}

// =============================================
// PERSISTENT CACHE
// =============================================
// MongoDB persistent cache
const MONGO_URI = process.env.MONGODB_URI || '';
let db = null;

async function connectDB() {
    if (!MONGO_URI) {
        console.log('[DB] No MONGODB_URI set — using memory-only cache');
        return;
    }
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db('iran_war_news');
        // Create indexes for fast lookups
        await db.collection('articles').createIndex({ hash: 1 }, { unique: true });
        await db.collection('translations').createIndex({ hash: 1 }, { unique: true });
        console.log('[DB] Connected to MongoDB Atlas');
    } catch (e) {
        console.log('[DB] MongoDB connection failed:', e.message, '— using memory-only cache');
        db = null;
    }
}

async function loadCacheFromDB() {
    let feeds = {}, translations = {}, feedTime = 0;
    if (!db) return { feeds, translations, feedTime };
    try {
        // Load articles grouped by category
        const articles = await db.collection('articles').find({}).toArray();
        for (const a of articles) {
            if (!feeds[a.category]) feeds[a.category] = [];
            delete a._id; // remove mongo _id
            feeds[a.category].push(a);
        }
        // Sort each category by date
        for (const cat of Object.keys(feeds)) {
            feeds[cat].sort((a, b) => {
                try { return new Date(b.pubDate) - new Date(a.pubDate); }
                catch { return 0; }
            });
        }
        const totalArticles = Object.values(feeds).flat().length;
        if (totalArticles > 0) console.log(`[DB] Loaded ${totalArticles} articles`);

        // Load translations
        const trans = await db.collection('translations').find({}).toArray();
        for (const t of trans) {
            translations[t.hash] = { title_he: t.title_he, description_he: t.description_he };
        }
        if (trans.length > 0) console.log(`[DB] Loaded ${trans.length} translations`);

        // Load metadata (last fetch time)
        const meta = await db.collection('meta').findOne({ key: 'lastFetchTime' });
        if (meta) feedTime = meta.value || 0;
    } catch (e) { console.log('[DB] Load failed:', e.message); }
    return { feeds, translations, feedTime };
}

async function saveFeedCache() {
    // Save to local file as fallback
    try {
        const CACHE_DIR = path.join(__dirname, '.cache');
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.promises.writeFile(path.join(CACHE_DIR, 'feeds.json'), JSON.stringify({ feeds: feedCache, timestamp: lastFetchTime })).catch(() => {});
    } catch (e) {}

    if (!db) return;
    try {
        const ops = [];
        for (const [category, articles] of Object.entries(feedCache)) {
            for (const a of articles) {
                const hash = articleHash(a);
                ops.push({
                    updateOne: {
                        filter: { hash },
                        update: { $set: { ...a, hash, category } },
                        upsert: true
                    }
                });
            }
        }
        if (ops.length > 0) {
            await db.collection('articles').bulkWrite(ops, { ordered: false });
        }
        await db.collection('meta').updateOne(
            { key: 'lastFetchTime' },
            { $set: { key: 'lastFetchTime', value: lastFetchTime } },
            { upsert: true }
        );
    } catch (e) { console.log('[DB] Feed save failed:', e.message); }
}

async function saveTranslationCache() {
    // Save to local file as fallback
    try {
        const CACHE_DIR = path.join(__dirname, '.cache');
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.promises.writeFile(path.join(CACHE_DIR, 'translations.json'), JSON.stringify(Object.fromEntries(translationCache))).catch(() => {});
    } catch (e) {}

    if (!db) return;
    try {
        const ops = [];
        for (const [hash, val] of translationCache) {
            ops.push({
                updateOne: {
                    filter: { hash },
                    update: { $set: { hash, title_he: val.title_he, description_he: val.description_he } },
                    upsert: true
                }
            });
        }
        if (ops.length > 0) {
            await db.collection('translations').bulkWrite(ops, { ordered: false });
        }
    } catch (e) { console.log('[DB] Translation save failed:', e.message); }
}

// Fallback: load from local file if no DB
function loadCacheFromDisk() {
    let feeds = {}, translations = {}, feedTime = 0;
    const CACHE_DIR = path.join(__dirname, '.cache');
    try {
        const feedFile = path.join(CACHE_DIR, 'feeds.json');
        if (fs.existsSync(feedFile)) {
            const data = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
            feeds = data.feeds || {};
            feedTime = data.timestamp || 0;
            console.log(`[CACHE] Loaded ${Object.values(feeds).flat().length} articles from disk`);
        }
    } catch (e) {}
    try {
        const transFile = path.join(CACHE_DIR, 'translations.json');
        if (fs.existsSync(transFile)) {
            const data = JSON.parse(fs.readFileSync(transFile, 'utf8'));
            translations = data;
            console.log(`[CACHE] Loaded ${Object.keys(translations).length} translations from disk`);
        }
    } catch (e) {}
    return { feeds, translations, feedTime };
}

// Initialize cache in memory (will be populated in startServer)
let feedCache = {};
let lastFetchTime = 0;
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

// =============================================
// TRANSLATION CACHE & STATE
// =============================================
const translationCache = new Map();
const MAX_CACHE_SIZE = 5000;
let translateStatus = { total: 0, done: 0, inProgress: false };

const WAR_START_DATE = new Date('2026-02-28T00:00:00Z');

function sanitizeUrl(url) {
    if (!url) return '';
    const lower = url.trim().toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) return url.trim();
    return '';
}

function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim().substring(0, 400);
}

function fetchRawFeed(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
                'Accept-Encoding': 'gzip, deflate',
            },
            timeout: 10000,
        }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchRawFeed(res.headers.location).then(resolve, reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`Status code ${res.statusCode}`));

            let stream = res;
            const encoding = res.headers['content-encoding'];
            if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
            else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
            else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

            const chunks = [];
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            stream.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 10000ms')); });
    });
}

async function fetchSingleFeed(feed) {
    try {
        const xml = await fetchRawFeed(feed.url);
        const result = await parser.parseString(xml);
        const nowMs = Date.now();
        // Detect timezone mislabeling: find max future offset across all items
        let maxAhead = 0;
        for (const item of result.items || []) {
            const raw = item.pubDate || item.isoDate || '';
            if (raw) {
                const t = new Date(raw).getTime();
                if (!isNaN(t) && t > nowMs) {
                    maxAhead = Math.max(maxAhead, t - nowMs);
                }
            }
        }
        const articles = (result.items || []).map(item => {
            let pubDate = item.pubDate || item.isoDate || '';
            // Shift all dates back by the detected offset (preserves relative order)
            if (pubDate && maxAhead > 0) {
                const d = new Date(pubDate);
                if (!isNaN(d)) {
                    pubDate = new Date(d.getTime() - maxAhead).toISOString();
                }
            }
            // Extract image from RSS item (enclosure, media:content, media:thumbnail, or fallback to img/source in HTML content)
            const rawContent = item.content || item['content:encoded'] || item.summary || '';
            const imgMatch = rawContent.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i)
                || rawContent.match(/<img[^>]+srcset=["']([^"',\s]+)/i)
                || rawContent.match(/<source[^>]+srcset=["']([^"',\s]+)/i)
                || rawContent.match(/<img[^>]+src=["']([^"']+)["']/i);
            const itemImage = (item.enclosure && item.enclosure.url) ||
                (item['media:content'] && item['media:content'].$  && item['media:content'].$.url) ||
                (item['media:thumbnail'] && item['media:thumbnail'].$ && item['media:thumbnail'].$.url) ||
                (item.itunes && item.itunes.image) ||
                (imgMatch && imgMatch[1]) ||
                '';
            return {
                title: item.title || '',
                description: stripHtml(item.contentSnippet || item.content || item.summary || item['content:encoded'] || ''),
                link: sanitizeUrl(item.link || item.guid || ''),
                image: sanitizeUrl(itemImage).replace(/[?&](width|height)=\d+/g, ''),
                pubDate,
                source: feed.name,
                country: feed.country,
                lang: feed.lang
            };
        });

        // Filter out articles before the war started (Feb 28, 2026)
        const recent = articles.filter(a => {
            if (!a.pubDate) return true; // keep articles with no date
            const d = new Date(a.pubDate);
            return isNaN(d) || d >= WAR_START_DATE;
        });

        // Filter for Iran/war relevance (two-tier)
        const filtered = recent.filter(a => {
            const text = a.title + ' ' + a.description;
            return isIranWarRelevant(text, a.lang);
        });

        return filtered;
    } catch (err) {
        console.log(`[WARN] Failed to fetch ${feed.name}: ${err.message}`);
        return [];
    }
}

async function _fetchAndUpdate() {
    console.log(`[INFO] Fetching all RSS feeds at ${new Date().toISOString()}`);
    const result = {};
    let totalArticles = 0;

    for (const [category, feeds] of Object.entries(FEEDS)) {
        const promises = feeds.map(feed => fetchSingleFeed(feed));
        const results = await Promise.allSettled(promises);

        let categoryArticles = [];
        results.forEach((res, i) => {
            if (res.status === 'fulfilled' && res.value.length > 0) {
                const articles = res.value.map(a => ({ ...a, category }));
                categoryArticles = categoryArticles.concat(articles);
                console.log(`  [OK] ${feeds[i].name}: ${res.value.length} articles`);
            } else {
                console.log(`  [FAIL] ${feeds[i].name}`);
            }
        });

        // Sort by date
        categoryArticles.sort((a, b) => {
            try { return new Date(b.pubDate) - new Date(a.pubDate); }
            catch { return 0; }
        });

        result[category] = categoryArticles;
        totalArticles += categoryArticles.length;
    }

    console.log(`[INFO] Total: ${totalArticles} articles fetched`);

    // Merge new results with existing cache — keep old articles from feeds that failed this time
    for (const [category, newArticles] of Object.entries(result)) {
        if (!feedCache[category]) {
            feedCache[category] = newArticles;
            continue;
        }
        // Build a set of existing article hashes for dedup
        const existingHashes = new Set();
        const merged = [...feedCache[category]];
        for (const a of merged) {
            existingHashes.add(articleHash(a));
        }
        // Add new articles that aren't already in cache
        for (const a of newArticles) {
            const hash = articleHash(a);
            if (!existingHashes.has(hash)) {
                merged.push(a);
                existingHashes.add(hash);
            }
        }
        // Sort by date
        merged.sort((a, b) => {
            try { return new Date(b.pubDate) - new Date(a.pubDate); }
            catch { return 0; }
        });
        // Cap at 500 articles per category to prevent unbounded memory growth
        feedCache[category] = merged.slice(0, 500);
    }
    lastFetchTime = Date.now();

    // Re-apply any existing translations to freshly fetched articles
    let reapplied = 0;
    for (const articles of Object.values(feedCache)) {
        for (const article of articles) {
            const hash = articleHash(article);
            if (translationCache.has(hash)) {
                const cached = translationCache.get(hash);
                article.title_he = cached.title_he;
                article.description_he = cached.description_he;
                reapplied++;
            }
        }
    }
    if (reapplied > 0) console.log(`[CACHE] Re-applied ${reapplied} cached translations`);

    saveFeedCache();

    // Trigger translation for new articles in background
    translateArticles();
}

async function fetchAllFeeds() {
    const now = Date.now();
    const hasCachedData = Object.keys(feedCache).length > 0;

    // Cache is fresh — return immediately
    if (now - lastFetchTime < CACHE_DURATION && hasCachedData) {
        return feedCache;
    }

    // Cache exists but stale — return cache now, refresh in background
    if (hasCachedData) {
        lastFetchTime = now; // prevent multiple background fetches
        _fetchAndUpdate();
        return feedCache;
    }

    // No cache at all — must fetch synchronously (first load)
    await _fetchAndUpdate();
    return feedCache;
}

// =============================================
// TRANSLATION
// =============================================
function articleHash(article) {
    return (article.title || '').substring(0, 80) + '|' + (article.source || '');
}

// Hebrew gender-fix: Google Translate often mixes masculine/feminine verb forms
// Common pattern: masculine noun + feminine verb suffix (ה) or vice versa
const HE_GENDER_FIXES = [
    // Masculine nouns that Google often pairs with feminine verbs
    // Pattern: [masculine noun context regex, feminine→masculine verb replacements]
    // Past tense feminine ה suffix → masculine (when subject is clearly male)
    // "זר" (male foreigner), "חשוד" (male suspect), "בכיר" (male senior official), "מפקד" (male commander), "שר" (male minister)
    // "נשיא" (president), "ראש ממשלה" (PM), "דובר" (spokesman), "קצין" (officer), "חייל" (soldier)
];

function fixHebrewGender(text) {
    if (!text) return text;

    // Rule 1: Masculine subject nouns followed by feminine past-tense verbs
    // Hebrew past tense feminine ends with ה, masculine doesn't
    const mascNouns = 'זר|חשוד|בכיר|מפקד|שר|נשיא|דובר|קצין|חייל|גנרל|מנהיג|פקיד|שגריר|אזרח|עיתונאי|לוחם|מרגל|סוכן|נאשם|עציר|שבוי';
    const femNouns = 'זרה|חשודה|בכירה|מפקדת|שרה|נשיאה|דוברת|קצינה|חיילת|מנהיגה|פקידה|שגרירה|אזרחית|עיתונאית|לוחמת|מרגלת|סוכנת|נאשמת|עצירה|שבויה';

    // Common verb pairs: feminine→masculine (past tense 3rd person singular)
    const verbPairs = [
        ['ריגלה', 'ריגל'], ['שימשה', 'שימש'], ['פעלה', 'פעל'], ['עבדה', 'עבד'],
        ['נעצרה', 'נעצר'], ['נהרגה', 'נהרג'], ['נפצעה', 'נפצע'], ['נתפסה', 'נתפס'],
        ['אמרה', 'אמר'], ['טענה', 'טען'], ['הודיעה', 'הודיע'], ['הכריזה', 'הכריז'],
        ['ביצעה', 'ביצע'], ['תכננה', 'תכנן'], ['הוציאה', 'הוציא'], ['שיגרה', 'שיגר'],
        ['ירתה', 'ירה'], ['תקפה', 'תקף'], ['הפציצה', 'הפציץ'], ['פגעה', 'פגע'],
        ['חשפה', 'חשף'], ['גילתה', 'גילה'], ['מסרה', 'מסר'], ['דיווחה', 'דיווח'],
        ['הזהירה', 'הזהיר'], ['איימה', 'איים'], ['הגיבה', 'הגיב'], ['סירבה', 'סירב'],
        ['ניסתה', 'ניסה'], ['הצליחה', 'הצליח'], ['נכשלה', 'נכשל'], ['ברחה', 'ברח'],
        ['חזרה', 'חזר'], ['הגיעה', 'הגיע'], ['יצאה', 'יצא'], ['נסעה', 'נסע'],
        ['עזבה', 'עזב'], ['הודתה', 'הודה'], ['הכחישה', 'הכחיש'], ['העידה', 'העיד'],
        ['הורשעה', 'הורשע'], ['זוכתה', 'זוכה'], ['נידונה', 'נידון'],
    ];
    // Reverse pairs: masculine→feminine (when subject is female)
    const reversePairs = verbPairs.map(([f, m]) => [m, f]);

    // Check if a masculine noun appears before verbs (within ~60 chars window)
    const mascRegex = new RegExp(`(?:^|\\s)(${mascNouns})(?:\\s|,|:)`, 'g');
    const femNounRegex = new RegExp(`(?:^|\\s)(${femNouns})(?:\\s|,|:)`, 'g');

    let result = text;
    const mascMatches = [...text.matchAll(mascRegex)];
    const femNounMatches = [...text.matchAll(femNounRegex)];

    // If masculine nouns found and NO feminine nouns, fix fem verbs → masc
    if (mascMatches.length > 0 && femNounMatches.length === 0) {
        for (const [femVerb, mascVerb] of verbPairs) {
            // Only replace if the feminine verb appears after a masculine noun context
            result = result.split(femVerb).join(mascVerb);
        }
    }
    // If feminine nouns found and NO masculine nouns, fix masc verbs → fem
    else if (femNounMatches.length > 0 && mascMatches.length === 0) {
        for (const [mascVerb, femVerb] of reversePairs) {
            result = result.split(mascVerb).join(femVerb);
        }
    }

    return result;
}

async function translateBatch(texts) {
    try {
        const results = await translate(texts, { from: 'auto', to: 'he' });
        const translated = Array.isArray(results) ? results.map(r => r.text) : [results.text];
        // Apply Hebrew gender correction to each translated text
        return translated.map(t => fixHebrewGender(t));
    } catch (err) {
        console.log(`[TRANSLATE] Batch failed: ${err.message}`);
        return texts; // fallback to original
    }
}

async function translateArticles() {
    if (translateStatus.inProgress) return;
    translateStatus.inProgress = true;

    // Collect all articles that need translation
    const allArticles = [];
    for (const articles of Object.values(feedCache)) {
        for (const article of articles) {
            const hash = articleHash(article);
            if (translationCache.has(hash)) {
                const cached = translationCache.get(hash);
                article.title_he = cached.title_he;
                article.description_he = cached.description_he;
            } else {
                allArticles.push(article);
            }
        }
    }

    translateStatus.total = allArticles.length + (translateStatus.total - allArticles.length);
    translateStatus.total = Object.values(feedCache).reduce((sum, arr) => sum + arr.length, 0);
    translateStatus.done = translateStatus.total - allArticles.length;

    console.log(`[TRANSLATE] ${allArticles.length} articles need translation, ${translateStatus.done} already cached`);

    // Process in batches of 10 articles (20 strings per batch)
    const BATCH_SIZE = 10;
    for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
        const batch = allArticles.slice(i, i + BATCH_SIZE);
        const textsToTranslate = [];
        for (const article of batch) {
            textsToTranslate.push(article.title || '');
            textsToTranslate.push(article.description || '');
        }

        const translated = await translateBatch(textsToTranslate);

        for (let j = 0; j < batch.length; j++) {
            const article = batch[j];
            article.title_he = translated[j * 2] || article.title;
            article.description_he = translated[j * 2 + 1] || article.description;

            const hash = articleHash(article);
            translationCache.set(hash, {
                title_he: article.title_he,
                description_he: article.description_he
            });
        }

        translateStatus.done += batch.length;
        console.log(`[TRANSLATE] Progress: ${translateStatus.done}/${translateStatus.total}`);

        // Evict old cache entries if over limit
        if (translationCache.size > MAX_CACHE_SIZE) {
            const keysToDelete = [...translationCache.keys()].slice(0, translationCache.size - MAX_CACHE_SIZE);
            keysToDelete.forEach(k => translationCache.delete(k));
        }

        // Delay between batches to avoid rate-limiting
        if (i + BATCH_SIZE < allArticles.length) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    translateStatus.inProgress = false;
    console.log(`[TRANSLATE] Complete: ${translateStatus.done}/${translateStatus.total} articles translated`);
    saveFeedCache();
    saveTranslationCache();
}

// =============================================
// TELEGRAM BOT
// =============================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '@iran_war_news_he';
const sentToTelegram = new Set(); // track sent article hashes to avoid duplicates

function telegramRequest(method, body) {
    return new Promise((resolve, reject) => {
        if (!TELEGRAM_BOT_TOKEN) return reject(new Error('No bot token'));
        const data = JSON.stringify(body);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, res => {
            let chunks = '';
            res.on('data', c => chunks += c);
            res.on('end', () => {
                try { resolve(JSON.parse(chunks)); }
                catch { resolve({ ok: false, description: chunks }); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function formatTelegramMessage(article) {
    const title = article.title_he || article.title || '';
    const desc = article.description_he || article.description || '';
    // Build 2-line summary: title on first line, short description on second
    const shortDesc = desc.length > 150 ? desc.substring(0, 150) + '...' : desc;
    const source = article.source || '';
    const link = article.link || '';

    // RTL mark (\u200F) ensures right-to-left display
    const lines = [
        `\u200F\u{1F534} *${title}*`,
        `\u200F${shortDesc}`,
        '',
        `\u200F\u{1F4F0} מקור: ${source}`,
    ];
    if (link) lines.push(`[\u{1F517} קרא עוד](${link})`);
    return lines.join('\n');
}

async function postToTelegram(article) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
    const hash = articleHash(article);
    if (sentToTelegram.has(hash)) return;

    const text = formatTelegramMessage(article);
    try {
        let result;
        if (article.image && article.image.startsWith('http')) {
            console.log(`[TELEGRAM] Sending PHOTO for "${article.source}": ${article.image.substring(0, 80)}`);
            // Send as photo with caption for articles that have images
            const caption = text.length > 1024 ? text.substring(0, 1021) + '...' : text;
            result = await telegramRequest('sendPhoto', {
                chat_id: TELEGRAM_CHANNEL_ID,
                photo: article.image,
                caption,
                parse_mode: 'Markdown',
            });
            // Fallback to text message if photo fails (e.g. invalid image URL)
            if (!result.ok) {
                result = await telegramRequest('sendMessage', {
                    chat_id: TELEGRAM_CHANNEL_ID,
                    text,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: false,
                });
            }
        } else {
            result = await telegramRequest('sendMessage', {
                chat_id: TELEGRAM_CHANNEL_ID,
                text,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
        }
        if (result.ok) {
            sentToTelegram.add(hash);
            // Cap the set size
            if (sentToTelegram.size > 2000) {
                const first = [...sentToTelegram].slice(0, 500);
                first.forEach(k => sentToTelegram.delete(k));
            }
        } else {
            console.log(`[TELEGRAM] Failed to send: ${result.description}`);
        }
    } catch (err) {
        console.log(`[TELEGRAM] Error: ${err.message}`);
    }
}

async function broadcastNewArticles() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        console.log('[TELEGRAM] Skipping broadcast — no TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID set');
        return;
    }
    // Collect all translated articles, sorted newest first
    const all = [];
    for (const articles of Object.values(feedCache)) {
        for (const a of articles) {
            if (a.title_he || a.lang === 'he') all.push(a);
        }
    }
    all.sort((a, b) => {
        try { return new Date(b.pubDate) - new Date(a.pubDate); }
        catch { return 0; }
    });

    let sent = 0;
    for (const article of all) {
        const hash = articleHash(article);
        if (sentToTelegram.has(hash)) continue;
        await postToTelegram(article);
        sent++;
        // Rate limit: max 20 messages per broadcast, 1s delay between
        if (sent >= 20) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (sent > 0) console.log(`[TELEGRAM] Broadcast ${sent} new articles`);
}

// =============================================
// PIKUD HAOREF — REAL-TIME ROCKET ALERTS
// =============================================
const OREF_ALERT_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_POLL_INTERVAL = 3000; // poll every 3 seconds
let lastOrefAlertId = null;

const OREF_CATEGORIES = {
    '1': '\u{1F534} ירי טילים ורקטות',
    '2': '\u{1F7E0} חדירת כלי טיס עוין',
    '3': '\u{1F7E1} רעידת אדמה',
    '4': '\u{1F30A} צונאמי',
    '5': '\u2622\uFE0F אירוע רדיולוגי',
    '6': '\u2623\uFE0F חומרים מסוכנים',
    '7': '\u{1F6A8} חדירת מחבלים',
    '13': '\u{1F534} ירי טילים ורקטות',
};

function fetchOrefAlerts() {
    return new Promise((resolve, reject) => {
        const req = https.get(OREF_ALERT_URL, {
            headers: {
                'Referer': 'https://www.oref.org.il/',
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': 'Mozilla/5.0',
            },
            timeout: 5000,
        }, (res) => {
            let data = '';
            // Handle BOM (byte order mark) that oref sometimes sends
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const clean = data.replace(/^\uFEFF/, '').trim();
                    if (!clean || clean === '{}' || clean === '[]') return resolve(null);
                    resolve(JSON.parse(clean));
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function formatOrefTelegramMessage(alert) {
    // Use the title directly from the API — it's already in Hebrew and accurate
    const category = alert.title || OREF_CATEGORIES[alert.cat] || '\u{1F6A8} התרעה';
    const cities = Array.isArray(alert.data) ? alert.data.join(', ') : (alert.data || '');
    const desc = alert.desc || 'היכנסו למרחב המוגן';

    return [
        `\u200F\u{1F6A8}\u{1F6A8}\u{1F6A8} *התרעת פיקוד העורף* \u{1F6A8}\u{1F6A8}\u{1F6A8}`,
        '',
        `\u200F${category}`,
        '',
        `\u200F\u{1F4CD} *אזורים:* ${cities}`,
        '',
        `\u200F\u{1F6E1}\uFE0F ${desc}`,
        '',
        `\u200F\u23F0 ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
    ].join('\n');
}

async function sendOrefAlertToTelegram(alert) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
    const text = formatOrefTelegramMessage(alert);
    try {
        const result = await telegramRequest('sendMessage', {
            chat_id: TELEGRAM_CHANNEL_ID,
            text,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
        });
        if (result.ok) {
            console.log(`[OREF] Alert sent to Telegram: ${alert.title} — ${(alert.data || []).join(', ')}`);
        } else {
            console.log(`[OREF] Telegram send failed: ${result.description}`);
        }
    } catch (err) {
        console.log(`[OREF] Telegram error: ${err.message}`);
    }
}

function startOrefPolling() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('[OREF] Skipping — no TELEGRAM_BOT_TOKEN set');
        return;
    }
    console.log('[OREF] Polling Pikud HaOref alerts every 3 seconds...');

    setInterval(async () => {
        try {
            const alert = await fetchOrefAlerts();
            if (!alert || !alert.id) {
                lastOrefAlertId = null;
                return;
            }
            // Only send if this is a new alert
            if (alert.id === lastOrefAlertId) return;
            lastOrefAlertId = alert.id;
            console.log(`[OREF] NEW ALERT: ${alert.title} | ${(alert.data || []).join(', ')}`);
            await sendOrefAlertToTelegram(alert);
        } catch (err) {
            // Silently ignore network errors (geo-block, timeout, etc.)
        }
    }, OREF_POLL_INTERVAL);
}

// Startup: connect DB, load cache, then fetch
async function startServer() {
    // 1. Connect to MongoDB if URI is set
    await connectDB();

    // 2. Load cache from DB (or fallback to disk)
    let diskCache;
    if (db) {
        diskCache = await loadCacheFromDB();
    } else {
        diskCache = loadCacheFromDisk();
    }
    feedCache = diskCache.feeds;
    lastFetchTime = diskCache.feedTime;
    for (const [hash, val] of Object.entries(diskCache.translations)) {
        translationCache.set(hash, val);
    }

    // 3. Re-apply cached translations to loaded articles
    for (const articles of Object.values(feedCache)) {
        for (const article of articles) {
            const hash = articleHash(article);
            if (translationCache.has(hash)) {
                const cached = translationCache.get(hash);
                article.title_he = cached.title_he;
                article.description_he = cached.description_he;
            }
        }
    }

    // 4. Fetch fresh feeds, translate, broadcast, update timeline
    fetchAllFeeds().then(() => translateArticles().then(() => { broadcastNewArticles(); generateDailyTimelineEntry(); }));

    // 5. Start Pikud HaOref alert polling
    startOrefPolling();

    // 6. Periodic refresh
    setInterval(async () => {
        lastFetchTime = 0;
        await fetchAllFeeds();
        await translateArticles();
        await broadcastNewArticles();
        generateDailyTimelineEntry();
    }, CACHE_DURATION);
}

startServer();

// =============================================
// ROUTES
// =============================================

// Serve only safe static files (NOT the full project directory)
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint for feeds
app.get('/api/feeds', async (req, res) => {
    try {
        const feeds = await fetchAllFeeds();
        // Map to Hebrew-only: replace title/description with Hebrew versions
        // Exclude articles that haven't been translated yet (unless already Hebrew)
        // Re-apply relevance filter to catch stale cached articles
        const hasHebrew = (text) => text && /[\u0590-\u05FF]/.test(text);
        const hebrewFeeds = {};
        for (const [category, articles] of Object.entries(feeds)) {
            hebrewFeeds[category] = articles
                .filter(a => a.lang === 'he' || hasHebrew(a.title_he))
                .filter(a => isIranWarRelevant((a.title_he || a.title || '') + ' ' + (a.description_he || a.description || ''), a.lang))
                .map(a => ({
                    ...a,
                    title: hasHebrew(a.title_he) ? a.title_he : a.title,
                    description: hasHebrew(a.description_he) ? a.description_he : a.description,
                }));
        }
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            feeds: hebrewFeeds
        });
    } catch (err) {
        console.error('[ERROR] /api/feeds:', err.message);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Force refresh
app.get('/api/refresh', async (req, res) => {
    lastFetchTime = 0;
    try {
        const feeds = await fetchAllFeeds();
        // Fire-and-forget translation + telegram broadcast in background
        translateArticles().then(() => broadcastNewArticles());
        // Map to Hebrew-only (same logic as /api/feeds)
        const hasHebrew = (text) => text && /[\u0590-\u05FF]/.test(text);
        const hebrewFeeds = {};
        for (const [category, articles] of Object.entries(feeds)) {
            hebrewFeeds[category] = articles
                .filter(a => a.lang === 'he' || hasHebrew(a.title_he))
                .map(a => ({
                    ...a,
                    title: hasHebrew(a.title_he) ? a.title_he : a.title,
                    description: hasHebrew(a.description_he) ? a.description_he : a.description,
                }));
        }
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            feeds: hebrewFeeds
        });
    } catch (err) {
        console.error('[ERROR] /api/refresh:', err.message);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Live data cache for ticker (oil prices, casualties, etc.)
const OIL_PREWAR_PRICE = 67.02; // Crude oil closing price on Feb 27, 2026 (last trading day before war)
let liveData = { oilPrice: null, oilDelta: null, casualties: null, lastFetch: 0 };

async function fetchOilPrice() {
    try {
        // Yahoo Finance API — real-time crude oil (CL=F)
        const data = await new Promise((resolve, reject) => {
            https.get('https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1d&range=1d', {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch { resolve(null); }
                });
            }).on('error', reject);
        });
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price && price > 30 && price < 300) {
            liveData.oilPrice = price;
            liveData.oilDelta = ((price - OIL_PREWAR_PRICE) / OIL_PREWAR_PRICE * 100).toFixed(1);
        }
    } catch (e) {
        console.log('[TICKER] Oil price fetch failed:', e.message);
    }
}

function extractCasualtiesFromNews() {
    const casualties = {
        iran_dead: null, iran_injured: null,
        lebanon_dead: null, lebanon_injured: null,
        israel_dead: null, israel_injured: null,
        us_dead: null, us_injured: null
    };

    const allText = [];
    for (const articles of Object.values(feedCache)) {
        for (const a of articles) {
            allText.push({
                text: (a.title || '') + ' ' + (a.title_he || '') + ' ' + (a.description || '') + ' ' + (a.description_he || ''),
                date: a.pubDate
            });
        }
    }
    allText.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Strict extraction: country must be VERY close to the number+action (within 15 chars)
    // to avoid "1200 killed in war... Israel and US attacked Iran" mismatches
    function findMax(patterns, min, max) {
        let best = null;
        for (const { text } of allText) {
            for (const pat of patterns) {
                const matches = text.matchAll(pat);
                for (const m of matches) {
                    const n = parseInt((m[1] || '0').replace(/,/g, ''));
                    if (n >= min && n <= max && (best === null || n > best)) {
                        best = n;
                    }
                }
            }
        }
        return best;
    }

    // Iran dead — look for "X killed in Iran" or "Iran: X killed" (tight context)
    casualties.iran_dead = findMax([
        /(?:iran|איראן|iranian).{0,15}(\d[\d,]+)\s*(?:kill|dead|death|הרוג|נהרג|died|people died)/gi,
        /(\d[\d,]+)\s*(?:kill|dead|death|הרוג|נהרג|died).{0,15}(?:iran|באיראן|iranian)/gi,
        /(?:iran|איראן):\s*(\d[\d,]+)\s*.{0,10}(?:kill|dead|נהרג|הרוג)/gi,
    ], 100, 500000);

    // Iran injured
    casualties.iran_injured = findMax([
        /(?:iran|איראן|באיראן).{0,15}(\d[\d,]+)\s*(?:injur|wound|פצוע|נפצע)/gi,
        /(\d[\d,]+)\s*(?:injur|wound|פצוע|נפצע).{0,15}(?:iran|באיראן)/gi,
    ], 100, 500000);

    // Lebanon dead
    casualties.lebanon_dead = findMax([
        /(?:lebanon|לבנון|בלבנון|lebanese).{0,15}(\d[\d,]+)\s*(?:kill|dead|death|הרוג|נהרג)/gi,
        /(\d[\d,]+)\s*(?:kill|dead|death|הרוג|נהרג).{0,15}(?:lebanon|בלבנון|lebanese)/gi,
    ], 10, 100000);

    // Lebanon injured
    casualties.lebanon_injured = findMax([
        /(?:lebanon|לבנון|בלבנון).{0,15}(\d[\d,]+)\s*(?:injur|wound|פצוע|נפצע)/gi,
        /(\d[\d,]+)\s*(?:injur|wound|פצוע|נפצע).{0,15}(?:lebanon|בלבנון)/gi,
    ], 10, 100000);

    // Israel dead — very strict: only "X Israelis killed" or "killed in Israel" patterns
    // Exclude "Israel attacked" / "Israel-US strikes" which are about Israel as attacker
    casualties.israel_dead = findMax([
        /(\d[\d,]+)\s*(?:israeli|ישראלי).{0,10}(?:kill|dead|נהרג|הרוג)/gi,
        /(\d[\d,]+)\s*(?:kill|dead|נהרג|הרוג).{0,10}(?:בישראל|in israel)/gi,
        /(?:בישראל|in israel).{0,10}(\d[\d,]+)\s*(?:kill|dead|נהרג|הרוג)/gi,
    ], 1, 50000);

    // Israel injured
    casualties.israel_injured = findMax([
        /(\d[\d,]+)\s*(?:israeli|ישראלי).{0,10}(?:injur|wound|פצוע|נפצע)/gi,
        /(\d[\d,]+)\s*(?:injur|wound|פצוע|נפצע).{0,10}(?:בישראל|in israel)/gi,
        /(?:בישראל|in israel).{0,10}(\d[\d,]+)\s*(?:injur|wound|פצוע|נפצע)/gi,
    ], 10, 500000);

    // US dead — military specifically
    // Hebrew number words map
    const heNumMap = { 'אחד': 1, 'שניים': 2, 'שנים': 2, 'שלושה': 3, 'שלוש': 3, 'ארבעה': 4, 'ארבע': 4,
        'חמישה': 5, 'חמש': 5, 'שישה': 6, 'שש': 6, 'שבעה': 7, 'שבע': 7, 'שמונה': 8, 'שמונת': 8,
        'תשעה': 9, 'תשע': 9, 'עשרה': 10, 'עשר': 10 };

    // Special: search for "death toll...to X" patterns for US military
    for (const { text } of allText) {
        // "brought the toll to 7" / "מניין ההרוגים...ל-7" / "death toll...to seven"
        const usDeathToll = text.match(/(?:אנשי שירות|service.?member|u\.s\.|אמריק|CENTCOM).{0,80}(?:מניין ההרוגים|death toll|toll).{0,30}(?:ל-?|to\s*)(\d+)/i) ||
                            text.match(/(?:מניין ההרוגים|death toll|toll).{0,30}(?:ל-?|to\s*)(\d+).{0,40}(?:אנשי שירות|service|u\.s\.|אמריק|CENTCOM)/i) ||
                            text.match(/(?:אנשי שירות|service.?member|u\.s\.|אמריק).{0,80}(?:מניין ההרוגים|death toll|toll).{0,30}(?:ל-?|to\s*)(שבעה|שמונה|תשעה|עשרה|שש|חמש|ארבע|שלוש)/i);
        if (usDeathToll) {
            let n = parseInt(usDeathToll[1]);
            if (isNaN(n)) n = heNumMap[usDeathToll[1]] || null;
            if (n && n > 0 && n < 10000 && (casualties.us_dead === null || n > casualties.us_dead)) {
                casualties.us_dead = n;
            }
        }
    }

    // Also try digit patterns
    const usDeadDigit = findMax([
        /(\d[\d,]*)\s*(?:american|u\.s\.|אמריק).{0,15}(?:soldier|troop|service|חייל|איש שירות).{0,10}(?:kill|dead|נהרג|died|מת)/gi,
        /(\d[\d,]*)\s*(?:kill|dead|נהרג|died|מת).{0,10}(?:american|u\.s\.|אמריק).{0,15}(?:soldier|troop|חייל|איש שירות)/gi,
    ], 1, 10000);
    if (usDeadDigit && (casualties.us_dead === null || usDeadDigit > casualties.us_dead)) {
        casualties.us_dead = usDeadDigit;
    }

    // US injured
    casualties.us_injured = findMax([
        /(\d[\d,]*)\s*(?:american|u\.s\.|אמריק).{0,15}(?:soldier|troop|חייל|איש שירות).{0,10}(?:injur|wound|פצוע|נפצע)/gi,
        /(\d[\d,]*)\s*(?:injur|wound|פצוע|נפצע).{0,10}(?:american|u\.s\.|אמריק).{0,15}(?:soldier|troop|חייל)/gi,
    ], 1, 50000);

    return casualties;
}

// =============================================
// MULTI-SOURCE CASUALTY TRACKING
// =============================================
// Fetches from multiple independent sources, cross-references, and picks consensus numbers

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : require('http');
        mod.get(url, { headers: { 'User-Agent': 'IranWarNewsBot/1.0 (conflict-tracker)' }, timeout: 12000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpGetJson(res.headers.location).then(resolve).catch(reject);
            }
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
    });
}

function extractFirstNum(text) {
    if (!text) return null;
    const m = text.match(/(\d[\d,]*)/);
    return m ? parseInt(m[1].replace(/,/g, '')) : null;
}

// Source 1: Wikipedia main war article
async function fetchWikipediaCasualties() {
    try {
        const data = await httpGetJson('https://en.wikipedia.org/w/api.php?action=parse&page=2026_Iran_war&prop=wikitext&format=json');
        if (!data || !data.parse) return null;
        const text = data.parse.wikitext['*'];
        const idx = text.indexOf('Casualties by country');
        if (idx < 0) return null;

        const section = text.substring(idx, idx + 8000);
        const rows = section.split('|-');
        const result = {};

        for (const row of rows) {
            let country = null;
            if (/\|Iran\s*\n/.test(row)) country = 'iran';
            else if (row.includes('|Lebanon')) country = 'lebanon';
            else if (/\|Israel\s*\n/.test(row)) country = 'israel';
            else if (row.includes('|United States')) country = 'us';
            else if (row.includes('!Total')) country = 'total';
            else continue;

            if (country === 'total') {
                const totalLines = row.split('\n').filter(l => l.startsWith('!'));
                result.total_dead = extractFirstNum(totalLines[1] || '');
                result.total_injured = extractFirstNum(totalLines[2] || '');
            } else {
                const allLines = row.split('\n').filter(l => l.startsWith('|'));
                let killedLine = allLines[1] || '';
                killedLine = killedLine.replace(/data-sort-value=\d+\|/, '');
                result[country + '_dead'] = extractFirstNum(killedLine);
                let injuredLine = allLines[2] || '';
                result[country + '_injured'] = extractFirstNum(injuredLine);
                if (country === 'iran' && !result.iran_injured) {
                    const injMatch = row.match(/\n\|(\d[\d,]+)\+?\s*\n\|Unknown/);
                    if (injMatch) result.iran_injured = parseInt(injMatch[1].replace(/,/g, ''));
                }
            }
        }
        console.log('[SRC] Wikipedia:', JSON.stringify(result));
        return result;
    } catch (e) {
        console.log('[SRC] Wikipedia failed:', e.message);
        return null;
    }
}

// Source 2: Hengaw Human Rights Organization — verified casualty reports from Iran
// Publishes structured reports with kill counts broken down by civilian/military
async function fetchHengawCasualties() {
    try {
        // Fetch the reports page to find the latest war casualty article
        const reportsBody = await new Promise((resolve) => {
            https.get('https://hengaw.net/en/reports-and-statistics-1', {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 10000
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => resolve(res.statusCode === 200 ? body : null));
            }).on('error', () => resolve(null));
        });

        if (!reportsBody) return null;

        // Find links to war-related articles (they contain casualty statistics)
        const articleLinks = [...reportsBody.matchAll(/href="(\/en\/reports-and-statistics-1\/2026\/\d+\/article-\d+)"/gi)]
            .map(m => m[1]);

        if (articleLinks.length === 0) return null;

        // Fetch the latest report article
        const latestUrl = 'https://hengaw.net' + articleLinks[0];
        const articleBody = await new Promise((resolve) => {
            https.get(latestUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => resolve(res.statusCode === 200 ? body : null));
            }).on('error', () => resolve(null));
        });

        if (!articleBody) return null;

        const text = articleBody.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

        const result = {};

        // Hengaw reports total killed in Iran (e.g., "4,300 killed" or "4,300 people have been killed")
        const totalKilledM = text.match(/(?:at least\s*)?(\d[\d,]+)\s*(?:people\s*)?(?:have been\s*)?killed/i);
        if (totalKilledM) {
            result.iran_dead = parseInt(totalKilledM[1].replace(/,/g, ''));
        }

        // Civilian vs military breakdown
        const civilianM = text.match(/(\d[\d,]+)\s*civilians/i);
        const militaryM = text.match(/(\d[\d,]+)\s*(?:were\s*)?(?:members of|government|military)/i);
        if (civilianM) result.iran_civilian_dead = parseInt(civilianM[1].replace(/,/g, ''));
        if (militaryM) result.iran_military_dead = parseInt(militaryM[1].replace(/,/g, ''));

        // Injured numbers if present
        const injuredM = text.match(/(\d[\d,]+)\s*(?:people\s*)?(?:have been\s*)?(?:injured|wounded)/i);
        if (injuredM) result.iran_injured = parseInt(injuredM[1].replace(/,/g, ''));

        if (Object.keys(result).length > 0) console.log('[SRC] Hengaw:', JSON.stringify(result));
        return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
        console.log('[SRC] Hengaw failed:', e.message);
        return null;
    }
}

// Source 3: ReliefWeb (UN OCHA) — situation reports with casualty numbers
async function fetchReliefWebCasualties() {
    try {
        const data = await httpGetJson('https://api.reliefweb.int/v1/reports?appname=iran-war-news&query[value]=iran+war+casualties+killed&filter[field]=country&filter[value][]=Iran+(Islamic+Republic+of)&filter[value][]=Lebanon&filter[value][]=Israel&sort[]=date:desc&limit=10&fields[include][]=title&fields[include][]=body');
        if (!data || !data.data || data.data.length === 0) return null;

        const result = {};
        const allText = data.data.map(r => (r.fields.title || '') + ' ' + (r.fields.body || '').substring(0, 2000)).join(' ');

        // Extract structured numbers from UN reports
        const countryPatterns = [
            { prefix: 'iran', names: ['Iran', 'Iranian'] },
            { prefix: 'lebanon', names: ['Lebanon', 'Lebanese'] },
            { prefix: 'israel', names: ['Israel', 'Israeli'] },
            { prefix: 'us', names: ['United States', 'American', 'U\\.S\\.'] },
        ];
        for (const cp of countryPatterns) {
            const nameAlt = cp.names.join('|');
            const deadRe = new RegExp(`(?:${nameAlt}).{0,40}?(\\d[\\d,]+)\\s*(?:killed|dead|deaths|fatalities)`, 'gi');
            const injRe = new RegExp(`(?:${nameAlt}).{0,40}?(\\d[\\d,]+)\\s*(?:injured|wounded)`, 'gi');
            let maxDead = null, maxInj = null;
            for (const m of allText.matchAll(deadRe)) {
                const n = parseInt(m[1].replace(/,/g, ''));
                if (n > 0 && n < 500000 && (!maxDead || n > maxDead)) maxDead = n;
            }
            for (const m of allText.matchAll(injRe)) {
                const n = parseInt(m[1].replace(/,/g, ''));
                if (n > 0 && n < 500000 && (!maxInj || n > maxInj)) maxInj = n;
            }
            if (maxDead) result[cp.prefix + '_dead'] = maxDead;
            if (maxInj) result[cp.prefix + '_injured'] = maxInj;
        }

        // Total
        const totalDeadRe = /[Tt]otal.{0,30}?(\d[\d,]+)\s*(?:killed|dead|deaths|fatalities)/g;
        for (const m of allText.matchAll(totalDeadRe)) {
            const n = parseInt(m[1].replace(/,/g, ''));
            if (n > 100 && (!result.total_dead || n > result.total_dead)) result.total_dead = n;
        }

        if (Object.keys(result).length > 0) console.log('[SRC] ReliefWeb:', JSON.stringify(result));
        return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
        console.log('[SRC] ReliefWeb failed:', e.message);
        return null;
    }
}

// Source 4: Wikipedia infobox TEMPLATE (casualties live in Template:2026_Iran_war_infobox)
async function fetchWikipediaInfobox() {
    try {
        const data = await httpGetJson('https://en.wikipedia.org/w/api.php?action=parse&page=Template:2026_Iran_war_infobox&prop=wikitext&format=json');
        if (!data || !data.parse) return null;
        const text = data.parse.wikitext['*'];
        const result = {};

        // Strip refs and efn for cleaner parsing
        const clean = text.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/<ref[^>]*\/>/g, '').replace(/\{\{efn\|[^}]*\}\}/g, '');

        // casualties1 = Israel/US side (per US and Israel)
        const cas1M = clean.match(/casualties1\s*=\s*([\s\S]*?)(?:\n\|\s*casualties2)/);
        if (cas1M) {
            const c1 = cas1M[1];
            // Israel: sum soldiers + civilians killed
            const ilSoldiersM = c1.match(/(\d[\d,]*)\s*soldiers?\s*killed/i);
            const ilCiviliansM = c1.match(/(\d[\d,]*)\s*civilians?\s*killed/i);
            const ilSoldiers = ilSoldiersM ? parseInt(ilSoldiersM[1].replace(/,/g, '')) : 0;
            const ilCivilians = ilCiviliansM ? parseInt(ilCiviliansM[1].replace(/,/g, '')) : 0;
            if (ilSoldiers + ilCivilians > 0) result.israel_dead = ilSoldiers + ilCivilians;

            // Israel injured: sum all injured numbers under Israel section
            const ilInjuredM = c1.match(/(\d[\d,]*)\s*injured/i);
            if (ilInjuredM) result.israel_injured = parseInt(ilInjuredM[1].replace(/,/g, ''));

            // US: military personnel killed/dead
            const usDeadM = c1.match(/United States[\s\S]{0,200}?(\d[\d,]*)\s*military\s*personnel\s*(?:killed|dead)/i) ||
                            c1.match(/(\d[\d,]*)\s*military\s*personnel\s*(?:killed|dead)/i);
            if (usDeadM) result.us_dead = parseInt(usDeadM[1].replace(/,/g, ''));

            // US injured
            const usInjM = c1.match(/(?:Around\s*)?(\d[\d,]*)\s*wounded/i);
            // Only assign if it appears after US section (not Israel's 2,557 injured)
            const usSection = c1.match(/United States[\s\S]*$/i);
            if (usSection) {
                const usWoundedM = usSection[0].match(/(?:Around\s*)?(\d[\d,]*)\s*wounded/i);
                if (usWoundedM) result.us_injured = parseInt(usWoundedM[1].replace(/,/g, ''));
            }
        }

        // casualties2 = Iran side
        const cas2M = clean.match(/casualties2\s*=\s*([\s\S]*?)(?:\n\|\s*casualties3)/);
        if (cas2M) {
            const c2 = cas2M[1];
            // Iran official: "1,255 people killed"
            const iranOfficialM = c2.match(/Per Iran[\s\S]*?(\d[\d,]*)\s*(?:people\s*)?killed/i);
            // Per US/Israel: "3,000 Iranian military personnel killed"
            const iranMilM = c2.match(/(\d[\d,]*)\s*Iranian\s*military\s*personnel\s*killed/i);
            // HRANA: "1,787 people killed"
            const hranaM = c2.match(/HRANA[\s\S]*?(\d[\d,]*)\s*(?:people\s*)?killed/i);
            // Hengaw: "4,300 killed"
            const hengawM = c2.match(/Hengaw[\s\S]*?(\d[\d,]*)\s*killed/i);

            // Use Iran's official figure for iran_dead (most conservative verified)
            if (iranOfficialM) result.iran_dead = parseInt(iranOfficialM[1].replace(/,/g, ''));
            // Store HRANA as an alternative for cross-reference
            if (hranaM) result.iran_dead_hrana = parseInt(hranaM[1].replace(/,/g, ''));
        }

        // casualties3 = Lebanon (non-belligerent)
        const cas3M = clean.match(/casualties3\s*=\s*([\s\S]*?)(?:\n\|\s*\w+\s*=|\n<!--)/);
        if (cas3M) {
            const c3 = cas3M[1];
            const lebDeadM = c3.match(/(\d[\d,]*)\s*killed/i);
            const lebInjM = c3.match(/(\d[\d,]*)\s*injured/i);
            if (lebDeadM) result.lebanon_dead = parseInt(lebDeadM[1].replace(/,/g, ''));
            if (lebInjM) result.lebanon_injured = parseInt(lebInjM[1].replace(/,/g, ''));
        }

        if (Object.keys(result).length > 0) console.log('[SRC] Wiki Infobox:', JSON.stringify(result));
        return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
        console.log('[SRC] Wiki Infobox failed:', e.message);
        return null;
    }
}

// Source 5: News headline extraction (existing logic)
function extractCasualtiesFromNewsSource() {
    return extractCasualtiesFromNews();
}

// =============================================
// CROSS-REFERENCE ENGINE
// =============================================
// Takes multiple source results and picks the most reliable consensus number

// Priority tiers: Wikipedia/OCHA are authoritative, others supplement
const SOURCE_PRIORITY = { 'Wikipedia': 1, 'Wiki-Infobox': 1, 'Hengaw': 2, 'ReliefWeb': 2, 'News-Extract': 3 };

function crossReferenceCasualties(sources) {
    const fields = ['total_dead', 'total_injured', 'iran_dead', 'iran_injured',
                     'lebanon_dead', 'lebanon_injured', 'israel_dead', 'israel_injured',
                     'us_dead', 'us_injured'];
    const result = {};

    for (const field of fields) {
        // Collect values grouped by priority tier
        const tier1 = [], tier2 = [], tier3 = [];
        for (const src of sources) {
            if (src.data && src.data[field] != null && src.data[field] > 0) {
                const prio = SOURCE_PRIORITY[src.name] || 3;
                if (prio === 1) tier1.push(src.data[field]);
                else if (prio === 2) tier2.push(src.data[field]);
                else tier3.push(src.data[field]);
            }
        }

        // Use highest-priority tier that has data
        // Cross-reference precision rule:
        // - If Tier 1 values are within 5% → use the higher (most recently updated)
        // - If Tier 1 values diverge >5% → use English Wikipedia value (most actively edited)
        // - Log disagreements for monitoring
        const pickBest = (arr, field) => {
            if (arr.length === 0) return null;
            if (arr.length === 1) return arr[0];
            arr.sort((a, b) => a - b);
            const min = arr[0], max = arr[arr.length - 1];
            const divergence = max > 0 ? (max - min) / max : 0;
            if (divergence > 0.05) {
                // >5% divergence — find English Wikipedia value
                const wikiSrc = sources.find(s => s.name === 'Wikipedia' && s.data && s.data[field] != null);
                if (wikiSrc) {
                    console.log(`[CROSS-REF] ${field}: values diverge ${(divergence * 100).toFixed(1)}% (${arr.join(', ')}), using Wikipedia: ${wikiSrc.data[field]}`);
                    return wikiSrc.data[field];
                }
            }
            // Within 5% — use the higher value (more recently updated)
            return max;
        };

        if (tier1.length > 0) result[field] = pickBest(tier1, field);
        else if (tier2.length > 0) result[field] = pickBest(tier2, field);
        else if (tier3.length > 0) result[field] = pickBest(tier3, field);
        else result[field] = null;
    }

    return { data: result };
}

async function fetchLiveData() {
    await fetchOilPrice();

    // Fetch all sources in parallel
    const [wiki, wikiInfobox, hengaw, reliefWeb] = await Promise.allSettled([
        fetchWikipediaCasualties(),
        fetchWikipediaInfobox(),
        fetchHengawCasualties(),
        fetchReliefWebCasualties(),
    ]);

    const sources = [
        { name: 'Wikipedia', data: wiki.status === 'fulfilled' ? wiki.value : null },
        { name: 'Wiki-Infobox', data: wikiInfobox.status === 'fulfilled' ? wikiInfobox.value : null },
        { name: 'Hengaw', data: hengaw.status === 'fulfilled' ? hengaw.value : null },
        { name: 'ReliefWeb', data: reliefWeb.status === 'fulfilled' ? reliefWeb.value : null },
        { name: 'News-Extract', data: extractCasualtiesFromNewsSource() },
    ].filter(s => s.data && Object.keys(s.data).length > 0);

    const activeSourceNames = sources.map(s => s.name);
    console.log(`[CASUALTY] Active sources: ${activeSourceNames.join(', ') || 'none'}`);

    if (sources.length > 0) {
        const { data, sourceDetails } = crossReferenceCasualties(sources);
        liveData.casualties = data;
        liveData.source = activeSourceNames.join(' + ');
        liveData.sourceCount = sources.length;
    } else {
        // Last resort: keep existing data
        if (!liveData.casualties) {
            liveData.casualties = { total_dead: null, total_injured: null };
            liveData.source = 'unavailable';
        }
    }

    liveData.lastFetch = Date.now();
    console.log(`[TICKER] Live data updated: oil=$${liveData.oilPrice || 'N/A'}, sources=${liveData.source} (${liveData.sourceCount || 0}), casualties=${JSON.stringify(liveData.casualties)}`);
}

// Fetch casualties from all sources every 30 seconds
setInterval(fetchLiveData, 30 * 1000);
// Fetch oil price every 30 seconds for real-time display
setInterval(fetchOilPrice, 30 * 1000);
// Initial fetch after 5 seconds (let feeds load first)
setTimeout(fetchLiveData, 5000);

// State media sources — claims may be unverified
const STATE_MEDIA_SOURCES = new Set([
    'Press TV', 'IRNA', 'Mehr News', 'Tehran Times', 'Fars News', 'Iran Press', 'Tasnim News'
]);
// Casualty-related keywords that trigger the unverified tag
const CASUALTY_CLAIM_PATTERN = /(\d+)\s*.{0,20}(הרג|נהרג|הרוג|killed|dead|death|casualties|פצוע|injured|wounded|נפצע|הרס|destroyed)/i;

// Ticker: top breaking headlines for the scrolling banner
app.get('/api/ticker', (req, res) => {
    const hasHebrew = (text) => text && /[\u0590-\u05FF]/.test(text);
    // Collect all translated articles, sorted by date
    const all = [];
    for (const articles of Object.values(feedCache)) {
        for (const a of articles) {
            const title = hasHebrew(a.title_he) ? a.title_he : (a.lang === 'he' ? a.title : null);
            if (title) all.push({ title, pubDate: a.pubDate, source: a.source, category: a.category });
        }
    }
    all.sort((a, b) => {
        try { return new Date(b.pubDate) - new Date(a.pubDate); }
        catch { return 0; }
    });
    // Return top 8 unique headlines (deduplicate by trimmed title)
    // Tag state media casualty claims as unverified
    const seen = new Set();
    const ticker = [];
    for (const a of all) {
        const short = a.title.substring(0, 60);
        if (seen.has(short)) continue;
        seen.add(short);
        let title = a.title;
        const isStateClaim = (a.category === 'iran-state' || STATE_MEDIA_SOURCES.has(a.source));
        if (isStateClaim && CASUALTY_CLAIM_PATTERN.test(title)) {
            title = title + ' [לא מאומת]';
        }
        ticker.push(title);
        if (ticker.length >= 8) break;
    }
    // War day counter (Feb 28 = day 1, so +1)
    const warDays = Math.floor((Date.now() - new Date('2026-02-28T00:00:00Z').getTime()) / 86400000) + 1;
    ticker.unshift(`יום ${warDays} למלחמה באיראן`);

    // Oil price
    if (liveData.oilPrice) {
        ticker.splice(1, 0, `מחיר הנפט: $${liveData.oilPrice}`);
    }

    res.json({ ticker });
});

// Live data: casualties + oil price
// =============================================
// AUTO-UPDATING WAR TIMELINE
// =============================================
const TIMELINE_CACHE_FILE = path.join(__dirname, '.cache', 'timeline.json');
const HARDCODED_TIMELINE = [
    { date: '2026-02-28', text: 'ישראל וארה"ב תוקפות את איראן. חמינאי נהרג בתקיפה.' },
    { date: '2026-03-01', text: 'איראן תוקפת בסיס אמריקאי בסעודיה. טיל בליסטי פוגע.' },
    { date: '2026-03-02', text: 'חיזבאללה יורה רקטות לצפון ישראל בתגובה.' },
    { date: '2026-03-06', text: 'ישראל תוקפת בירות וטהרן. טראמפ דורש כניעה.' },
    { date: '2026-03-09', text: 'מוג\'תבא חמינאי מונה כמנהיג העליון החדש של איראן.' },
    { date: '2026-03-10', text: 'איראן נשבעת להשתמש בטילים חזקים, דוחה שיחות עם טראמפ.' },
    { date: '2026-03-11', text: 'איראן פורסת מוקשים במצר הורמוז. מטח טילים בליסטיים מסיבי לעבר תל אביב וחיפה.' },
    { date: '2026-03-12', text: 'עיראק סוגרת נמלי נפט. איראן מציבה 3 תנאים לסיום המלחמה.' },
];
let autoTimeline = [];

function loadTimeline() {
    try {
        if (fs.existsSync(TIMELINE_CACHE_FILE)) {
            autoTimeline = JSON.parse(fs.readFileSync(TIMELINE_CACHE_FILE, 'utf8'));
            console.log(`[TIMELINE] Loaded ${autoTimeline.length} entries from disk`);
        }
    } catch (e) {}
    // Merge hardcoded entries for dates that have no auto-generated entry
    const autoDates = new Set(autoTimeline.map(e => e.date));
    for (const entry of HARDCODED_TIMELINE) {
        if (!autoDates.has(entry.date)) {
            autoTimeline.push(entry);
        }
    }
    autoTimeline.sort((a, b) => a.date.localeCompare(b.date));
}

function saveTimeline() {
    try {
        const dir = path.join(__dirname, '.cache');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(TIMELINE_CACHE_FILE, JSON.stringify(autoTimeline, null, 2));
    } catch (e) {}
}

// Analyze today's articles and pick the top events for the timeline
function generateDailyTimelineEntry() {
    const today = new Date().toISOString().split('T')[0];
    // Don't overwrite if we already have an entry for today that was manually set or hardcoded
    const existing = autoTimeline.find(e => e.date === today);
    if (existing && existing.locked) return;

    // Collect today's articles (Hebrew titles preferred)
    const todayArticles = [];
    for (const articles of Object.values(feedCache)) {
        for (const a of articles) {
            if (!a.pubDate) continue;
            const artDate = new Date(a.pubDate).toISOString().split('T')[0];
            if (artDate !== today) continue;
            const title = (a.title_he || a.title || '').trim();
            if (title.length > 10) todayArticles.push(title);
        }
    }

    if (todayArticles.length < 3) return; // Not enough data yet

    // Find most-reported topics by looking for repeated keywords across headlines
    // Score each article title by how many other titles share significant words with it
    const significantWords = new Map(); // word -> count
    const stopWords = new Set(['את', 'של', 'על', 'לא', 'עם', 'כי', 'גם', 'הוא', 'היא', 'זה', 'מה', 'אם', 'כל', 'אחרי', 'לפני', 'בין', 'אל', 'או', 'עד', 'רק', 'כבר', 'עוד', 'the', 'is', 'in', 'of', 'to', 'and', 'a', 'for', 'on', 'at', 'as', 'by', 'an', 'be', 'it', 'that', 'says', 'said', 'after', 'from', 'with', 'has', 'its', 'are', 'was', 'were', 'will', 'have', 'new', 'been', 'more', 'over']);

    for (const title of todayArticles) {
        const words = title.split(/[\s,.:;!?()\[\]"']+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
        const unique = new Set(words.map(w => w.toLowerCase()));
        for (const w of unique) {
            significantWords.set(w, (significantWords.get(w) || 0) + 1);
        }
    }

    // Score each title by sum of its word frequencies (higher = more widely reported)
    const scored = todayArticles.map(title => {
        const words = title.split(/[\s,.:;!?()\[\]"']+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
        const score = words.reduce((s, w) => s + (significantWords.get(w.toLowerCase()) || 0), 0);
        return { title, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // Take top 2 distinct headlines (deduplicate similar ones)
    const picked = [];
    for (const item of scored) {
        if (picked.length >= 2) break;
        // Skip if too similar to already picked
        const dominated = picked.some(p => {
            const overlap = item.title.split(/\s+/).filter(w => p.title.includes(w)).length;
            return overlap > 4;
        });
        if (dominated) continue;
        // Trim to concise length (max ~50 chars per headline)
        let text = item.title;
        if (text.length > 50) text = text.substring(0, 47) + '...';
        picked.push({ title: text });
    }

    if (picked.length === 0) return;

    const summary = picked.map(p => p.title).join('. ');
    const entry = { date: today, text: summary, auto: true };

    // Replace or add
    const idx = autoTimeline.findIndex(e => e.date === today);
    if (idx >= 0) {
        autoTimeline[idx] = entry;
    } else {
        autoTimeline.push(entry);
        autoTimeline.sort((a, b) => a.date.localeCompare(b.date));
    }
    saveTimeline();
    console.log(`[TIMELINE] Auto-generated entry for ${today}: ${summary.substring(0, 80)}`);
}

// Run timeline generation after each feed refresh
loadTimeline();

app.get('/api/timeline', (req, res) => {
    // Format dates to Hebrew display
    const months = ['ינו\'', 'פבר\'', 'מרץ', 'אפר\'', 'מאי', 'יוני', 'יולי', 'אוג\'', 'ספט\'', 'אוק\'', 'נוב\'', 'דצמ\''];
    // Reverse: newest first
    const reversed = [...autoTimeline].reverse();
    const formatted = reversed.map(e => {
        const d = new Date(e.date + 'T00:00:00');
        const day = d.getDate();
        const month = months[d.getMonth()];
        const year = d.getFullYear();
        // Show year only for last entry (oldest, which is the war start)
        const isOldest = e === autoTimeline[0];
        return {
            date: isOldest ? `${day} ${month} ${year}` : `${day} ${month}`,
            text: e.text,
            auto: !!e.auto,
        };
    });
    res.json({ timeline: formatted });
});

app.get('/api/live-data', (req, res) => {
    res.json({
        oilPrice: liveData.oilPrice,
        oilDelta: liveData.oilDelta,
        casualties: liveData.casualties,
        source: liveData.source || 'news',
        sourceCount: liveData.sourceCount || 0,
        lastUpdate: liveData.lastFetch ? new Date(liveData.lastFetch).toISOString() : null
    });
});

// Translation status
app.get('/api/translate-status', (req, res) => {
    res.json({
        total: translateStatus.total,
        done: translateStatus.done,
        inProgress: translateStatus.inProgress,
        percent: translateStatus.total > 0 ? Math.round((translateStatus.done / translateStatus.total) * 100) : 0,
        cacheSize: translationCache.size
    });
});

// Telegram channel info
app.get('/api/telegram-channel', (req, res) => {
    res.json({ channel: TELEGRAM_CHANNEL_ID || null });
});

// Favicon
app.get('/favicon.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'favicon.png'));
});

// Main route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', cached: Object.keys(feedCache).length > 0, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`Iran War News Aggregator running on port ${PORT}`);
});
