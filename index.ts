import { MongoClient, type Collection, type Document } from "mongodb";
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";

// ############ KONFIGURATION ############
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3030;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || "quranDB";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "quranverse_coll";

if (!MONGO_URI) {
    console.error("❌ MONGO_URI fehlt! Bitte in quran-api/.env hinterlegen (siehe .env.example).");
    process.exit(1);
}

// ############ DATENBANK-VERBINDUNG & CACHE ############
const client = new MongoClient(MONGO_URI);
let versesCollection: Collection<Document>;
let cachedSuras: Document[] | null = null;

function parsePagination(query: Record<string, string | undefined>, defaultLimit = 25, maxLimit = 100) {
    const rawPage = parseInt(query.page || "1", 10);
    const rawLimit = parseInt(query.limit || String(defaultLimit), 10);
    const page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? defaultLimit : Math.min(rawLimit, maxLimit);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
}

async function loadSurasCache() {
    cachedSuras = await versesCollection.aggregate([
        {
            $group: {
                _id: "$sura_index",
                sura_index: { $first: "$sura_index" },
                sura_name_ar: { $first: "$sura_name_ar" },
                sura_name_en: { $first: "$sura_name_en" },
                sura_name_de: { $first: "$sura_name_de" },
                revelation_type: { $first: "$revelation_type" },
                verses_count: { $max: "$aya_index" }
            }
        },
        { $sort: { sura_index: 1 } }
    ]).toArray();
    return cachedSuras;
}

async function connectToDb() {
    try {
        await client.connect();
        const db = client.db(DB_NAME);
        versesCollection = db.collection(COLLECTION_NAME);
        await loadSurasCache();
        console.log(`✅ Erfolgreich mit MongoDB (${DB_NAME}.${COLLECTION_NAME}) verbunden! (${cachedSuras?.length ?? 0} Suren gecacht)`);
    } catch (e) {
        console.error("❌ Verbindung zur MongoDB fehlgeschlagen:", e);
        process.exit(1);
    }
}

// ############ BUN WEB-SERVER ############
async function startServer() {
    await connectToDb();

    const app = new Elysia()
        .use(cors())

        // --- Healthcheck ---
        .get("/health", () => ({
            status: "ok",
            db: DB_NAME,
            collection: COLLECTION_NAME,
            surasCached: cachedSuras?.length ?? 0
        }))

        // --- Endpunkt 0: Übersicht aller 114 Suren (gecacht) ---
        .get("/suras", async () => {
            if (!cachedSuras || cachedSuras.length === 0) {
                return await loadSurasCache();
            }
            return cachedSuras;
        })

        // --- Endpunkt 1: Einen einzelnen Vers abrufen (mit Wort-für-Wort-Analyse) ---
        .get("/verses/:suraIndex/:ayaIndex", async ({ params, status }) => {
            const suraIndex = parseInt(params.suraIndex, 10);
            const ayaIndex = parseInt(params.ayaIndex, 10);

            if (Number.isNaN(suraIndex) || Number.isNaN(ayaIndex)) {
                return status(400, { message: "Ungültiger Suren- oder Vers-Index." });
            }

            const verse = await versesCollection.findOne({
                sura_index: suraIndex,
                aya_index: ayaIndex
            });

            if (!verse) {
                return status(404, { message: "Vers nicht gefunden." });
            }
            return verse;
        })

        // --- Endpunkt 2: Eine ganze Sure abrufen (Kontext / Siyāq) ---
        .get("/suras/:suraIndex", async ({ params, status }) => {
            const suraIndex = parseInt(params.suraIndex, 10);

            if (Number.isNaN(suraIndex) || suraIndex < 1 || suraIndex > 114) {
                return status(400, { message: "Ungültiger Suren-Index (erlaubt: 1–114)." });
            }

            const sura = await versesCollection
                .find({ sura_index: suraIndex })
                .sort({ aya_index: 1 })
                .toArray();

            if (sura.length === 0) {
                return status(404, { message: "Sure nicht gefunden." });
            }
            return sura;
        })

        // --- Endpunkt 3: Volltext-, Referenz- & Begriffssuche (mit Pagination) ---
        .get("/search", async ({ query, status }) => {
            const searchQuery = (query.q || "").trim();

            if (!searchQuery) {
                return status(400, { message: "Bitte geben Sie einen Suchbegriff an. Beispiel: /search?q=frieden" });
            }

            const { page, limit, skip } = parsePagination(query, 25, 100);

            // 1. Sure:Vers Referenz (z.B. "62:9" oder "62 9")
            const refMatch = searchQuery.match(/^(\d+)[ :]+(\d+)$/);
            if (refMatch?.[1] && refMatch?.[2]) {
                const s = parseInt(refMatch[1], 10);
                const a = parseInt(refMatch[2], 10);
                const verse = await versesCollection.findOne({ sura_index: s, aya_index: a });
                const verses = verse ? [verse] : [];
                return {
                    query: searchQuery,
                    total: verses.length,
                    page: 1,
                    limit,
                    totalPages: verses.length > 0 ? 1 : 0,
                    hasMore: false,
                    verses
                };
            }

            // 2. Surennummer (z.B. "Sure 62" oder "62")
            const suraNumMatch = searchQuery.match(/^(?:sure|surah)?\s*(\d+)$/i);
            if (suraNumMatch?.[1]) {
                const s = parseInt(suraNumMatch[1], 10);
                if (s >= 1 && s <= 114) {
                    const [total, verses] = await Promise.all([
                        versesCollection.countDocuments({ sura_index: s }),
                        versesCollection
                            .find({ sura_index: s })
                            .sort({ aya_index: 1 })
                            .skip(skip)
                            .limit(limit)
                            .toArray()
                    ]);
                    const totalPages = Math.ceil(total / limit);
                    return {
                        query: searchQuery,
                        total,
                        page,
                        limit,
                        totalPages,
                        hasMore: page < totalPages,
                        verses
                    };
                }
            }

            // 3. Arabische Wurzel mit Leerzeichen (z.B. "س ع ي") oder exakte Wurzel
            const strippedArabic = searchQuery.replace(/\s+/g, "");
            const isSpacedArabicRoot = /^[\u0621-\u064A](\s+[\u0621-\u064A]){2,3}$/.test(searchQuery);
            if (isSpacedArabicRoot) {
                const filter = { "words.root": strippedArabic };
                const [total, verses] = await Promise.all([
                    versesCollection.countDocuments(filter),
                    versesCollection
                        .find(filter)
                        .sort({ sura_index: 1, aya_index: 1 })
                        .skip(skip)
                        .limit(limit)
                        .toArray()
                ]);
                const totalPages = Math.ceil(total / limit);
                return {
                    query: searchQuery,
                    matchedRoot: strippedArabic,
                    total,
                    page,
                    limit,
                    totalPages,
                    hasMore: page < totalPages,
                    verses
                };
            }

            // 4. Volltextsuche über MongoDB Text-Index
            try {
                const textFilter = { $text: { $search: searchQuery } };
                const total = await versesCollection.countDocuments(textFilter);
                if (total > 0) {
                    const verses = await versesCollection
                        .find(textFilter, {
                            projection: { score: { $meta: "textScore" } }
                        })
                        .sort({ score: { $meta: "textScore" } })
                        .skip(skip)
                        .limit(limit)
                        .toArray();
                    const totalPages = Math.ceil(total / limit);
                    return {
                        query: searchQuery,
                        total,
                        page,
                        limit,
                        totalPages,
                        hasMore: page < totalPages,
                        verses
                    };
                }
            } catch (e) {
                console.warn("Text search fallback:", e);
            }

            // 5. Fallback: Regex-Suche über Übersetzungen, arabischen Text und Wurzeln
            const cleanQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const regex = new RegExp(cleanQuery, "i");
            const regexFilter = {
                $or: [
                    { "translations.abu_rida": regex },
                    { "translations.bubenheim": regex },
                    { "translations.khoury": regex },
                    { "translations.zaidan": regex },
                    { arabic_text: regex },
                    { sura_name_de: regex },
                    { sura_name_en: regex },
                    { "words.root": strippedArabic },
                    { "words.translation_word": regex },
                    { "words.transliteration": regex }
                ]
            };

            const [total, verses] = await Promise.all([
                versesCollection.countDocuments(regexFilter),
                versesCollection
                    .find(regexFilter)
                    .sort({ sura_index: 1, aya_index: 1 })
                    .skip(skip)
                    .limit(limit)
                    .toArray()
            ]);

            const totalPages = Math.ceil(total / limit);
            return {
                query: searchQuery,
                total,
                page,
                limit,
                totalPages,
                hasMore: page < totalPages,
                verses
            };
        })

        // --- Endpunkt 4: Suche nach arabischem Wortstamm (Root) mit Pagination ---
        .get("/roots/:root", async ({ params, query, status }) => {
            const rawRoot = decodeURIComponent(params.root).trim().replace(/\s+/g, "");
            if (!rawRoot) {
                return status(400, { message: "Ungültiger Wortstamm." });
            }

            const { page, limit, skip } = parsePagination(query, 25, 100);
            const filter = { "words.root": rawRoot };

            const [total, verses] = await Promise.all([
                versesCollection.countDocuments(filter),
                versesCollection
                    .find(filter)
                    .sort({ sura_index: 1, aya_index: 1 })
                    .skip(skip)
                    .limit(limit)
                    .toArray()
            ]);

            const totalPages = Math.ceil(total / limit);

            return {
                root: rawRoot,
                root_spaced: rawRoot.split("").join(" "),
                count: total,
                total,
                page,
                limit,
                totalPages,
                hasMore: page < totalPages,
                verses
            };
        })

        // --- Start des Servers ---
        .listen(PORT);

    console.log(`✅ Elysia-Server läuft auf http://localhost:${PORT}`);
}

startServer();
