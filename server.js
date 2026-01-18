// require('dotenv').config();
const express = require("express");
const mysql = require("mysql2/promise");
const crypto = require('crypto');
const cors = require("cors");
const rateLimit = require('express-rate-limit');
const app = express();
const router = express.Router();

//Rate Limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: "Çok fazla istek, lütfen bekleyin" } }
});

app.use(express.json());
app.use(cors());
app.use(limiter);

//Response Helpers
const sendSuccess = (res, data, status = 200) => res.status(status).json({ success: true, data });
const sendError = (res, message, status = 500) => res.status(status).json({ success: false, error: { message } });

//DB Connection
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

//Ana url çalışıyor mu kontrolü
app.get("/", (req, res) => {
 res.send("API çalışıyor");
});

// 1. MAIN-LANGUAGES (Sıralama ID'ye göre)
router.get("/main-languages", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT main_lang_id, main_lang_name FROM main_lang ORDER BY main_lang_id ASC"
    );
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Main languages list could not be retrieved.");
  }
});

// 2. TARGET-LANGUAGES (Sıralama ID'ye göre)
router.get("/target-languages", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT target_lang_id, target_lang_name FROM target_lang ORDER BY target_lang_id ASC"
    );
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Target languages list could not be retrieved.");
  }
});

// 3. CATEGORIES (Sıralama ID'ye göre)
router.get("/categories", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT category_id, category_name FROM category ORDER BY category_id ASC"
    );
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Categories list could not be retrieved.");
  }
});

// 4. MODULES - Modülleri listeler (Learn, Test vb.)
router.get("/modules", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT module_id, module_name FROM module ORDER BY module_id ASC"
    );
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Modules list could not be retrieved.");
  }
});

// 5. WORD STREAM - Belirli kategori ve dilde rastgele 10 kelime getirir
router.post("/word-stream", async (req, res) => {
  const { target_lang_id, category_id } = req.body;

  // Eksik parametre kontrolü
  if (!target_lang_id || !category_id) {
    return sendError(res, "Target language and Category are required.");
  }

  try {
    // Rastgele 10 kelime seçer. 
    // word, sentence ve pronunciation alanlarından veri yoksa NULL döner, 
    // uygulama (frontend) kısmında bu NULL kontrolünü yapmalısın.
    const query = `
      SELECT word_id, target_lang_id, category_id, word, sentence, pronunciation 
      FROM word 
      WHERE target_lang_id = ? AND category_id = ? 
      ORDER BY RAND() 
      LIMIT 10
    `;

    const [rows] = await db.execute(query, [target_lang_id, category_id]);

    if (rows.length === 0) {
      return sendError(res, "No words found for the selected category.");
    }

    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "An error occurred while fetching words.");
  }
});

// 6. WORD MEANING - Kelimenin ana dildeki anlamını ve detaylarını getirir
router.get("/word-meaning/:word_id/:main_lang_id", async (req, res) => {
  const { word_id, main_lang_id } = req.params;

  try {
    const query = `
      SELECT 
        meaning_id, 
        word_id, 
        main_lang_id, 
        word_meaning, 
        word_defination, 
        sentence_meaning 
      FROM meaning 
      WHERE word_id = ? AND main_lang_id = ?
    `;

    const [rows] = await db.execute(query, [word_id, main_lang_id]);

    if (rows.length === 0) {
      return sendError(res, "Meaning not found for the selected language.");
    }

    // Tek bir kelime için tek bir anlam döneceği için rows[0] gönderiyoruz
    return sendSuccess(res, rows[0]);
  } catch (err) {
    return sendError(res, "An error occurred while fetching the meaning.");
  }
});


app.use('/api/v1', router);
app.listen(3000, "0.0.0.0", () => console.log("WordApp API running on port 3000!"));
