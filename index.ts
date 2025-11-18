import { MongoClient, Collection, Document } from "mongodb";
import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors'

// ############ KONFIGURATION ############
// Fügen Sie hier Ihre Connection String von MongoDB Atlas ein
// ERSETZEN SIE <password> MIT IHREM ECHTEN DATENBANK-PASSWORT
const MONGO_URI = "mongodb+srv://admin:test1234@cluster0.umjyj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const dbName = 'quran_db';
const collectionName = 'verses';

// ############ DATENBANK-VERBINDUNG ############
const client = new MongoClient(MONGO_URI);
let versesCollection: Collection<Document>;

async function connectToDb() {
    try {
        await client.connect();
        const db = client.db(dbName);
        versesCollection = db.collection(collectionName);
        console.log("✅ Erfolgreich mit MongoDB verbunden!");
    } catch (e) {
        console.error("❌ Verbindung zur MongoDB fehlgeschlagen:", e);
        process.exit(1); // Beendet das Programm bei einem Fehler
    }
}

// ############ BUN WEB-SERVER ############
async function startServer() {
    await connectToDb();

    const app = new Elysia()
        .use(cors()) 
        // --- Endpunkt 1: Einen einzelnen Vers abrufen ---
        .get('/verses/:suraIndex/:ayaIndex', async ({ params, error }) => {
            const suraIndex = parseInt(params.suraIndex);
            const ayaIndex = parseInt(params.ayaIndex);

            if (isNaN(suraIndex) || isNaN(ayaIndex)) {
                return error(400, 'Ungültiger Suren- oder Vers-Index.');
            }

            const verse = await versesCollection.findOne({ 
                sura_index: suraIndex, 
                aya_index: ayaIndex 
            });

            if (!verse) {
                return error(404, 'Vers nicht gefunden.');
            }
            return verse;
        })

        // --- Endpunkt 2: Eine ganze Sure abrufen ---
        .get('/suras/:suraIndex', async ({ params, error }) => {
            const suraIndex = parseInt(params.suraIndex);

            if (isNaN(suraIndex)) {
                return error(400, 'Ungültiger Suren-Index.');
            }

            const sura = await versesCollection.find({ 
                sura_index: suraIndex 
            }).sort({ 
                aya_index: 1
            }).toArray();

            if (sura.length === 0) {
                return error(404, 'Sure nicht gefunden.');
            }
            return sura;
        })

        // --- Endpunkt 3: Volltextsuche ---
        .get('/search', async ({ query, error }) => {
            const searchQuery = query.q; // Holt den Suchbegriff aus ?q=...

            if (!searchQuery || searchQuery.trim() === '') {
                return error(400, 'Bitte geben Sie einen Suchbegriff an. Beispiel: /search?q=frieden');
            }
            
            const results = await versesCollection.find({
                $text: { $search: searchQuery }
            }).toArray();
            
            return results;
        })

        // --- Start des Servers ---
        .listen(3030);

    console.log(`✅ Elysia-Server läuft auf http://localhost:${app.server?.port}`);
}

startServer();