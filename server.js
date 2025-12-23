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

// 1. MY-LANGUAGES (Sıralama ID'ye çekildi)
router.get("/my-languages", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT mylang_id, mylang_code, mylang_name FROM mylanguage ORDER BY mylang_id ASC");
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Ana diller listesi alınamadı.");
  }
});

// 2. LANGUAGES (Sıralama ID'ye çekildi)
router.get("/languages", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT lang_id, lang_code, lang_name FROM language ORDER BY lang_id ASC");
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Diller listesi alınamadı.");
  }
});

// 3. MENU-SOURCES (Kategoriler ID'ye göre sıralandı)
router.get("/menu-sources", async (req, res) => {
  const { lang_id, visitor_id } = req.query;
  if (!lang_id) return sendError(res, "lang_id zorunlu", 400);
  try {
  //1.grup mevcut dile ait kategoriler gelir.
    const [categories] = await db.execute(`
      SELECT DISTINCT c.category_id, c.category_name 
      FROM categories c
      INNER JOIN word_category wc ON c.category_id = wc.category_id
      WHERE wc.lang_id = ? 
      ORDER BY c.category_id ASC`, [lang_id]);

  //2.grup Kullanıcının kendi listeleri (Favori var mı kontrolü) 
    let userLists = [
      { id: 'my_words_current', name: 'Kelimelerim (Seçili Dil)', active: false },
      { id: 'my_words_all', name: 'Tüm Kelimelerim', active: false }
    ];
    
    if (visitor_id) {
      const [stats] = await db.execute(`
        SELECT 
          COUNT(CASE WHEN lang_id = ? THEN 1 END) as current_count,
          COUNT(*) as total_count
        FROM mywords WHERE visitor_id = ?`, [lang_id, visitor_id]);
      userLists[0].active = stats[0].current_count > 0;
      userLists[1].active = stats[0].total_count > 0;
    }
//frontend için birleştirilmiş yapı
    return sendSuccess(res, { categories: categories, user_lists: userLists });
  } catch (err) {
    console.error(err);
    return sendError(res, "Menü kaynakları alınamadı.");
  }
});

// 4. WORDS/RANDOM (Orijinal haliyle bırakıldı)
router.get("/words/random", async (req, res) => {
  const { lang_id, category_id, visitor_id, source_type = "category", limit = 10 } = req.query;
  try {
    const limitVal = parseInt(limit) || 10;
    let sql = "";
    const params = [];

    if (source_type === "my_words_current" || source_type === "my_words_all") {
      if (!visitor_id) return sendSuccess(res, []);
      sql = `SELECT w.*, 1 AS is_favorite FROM mywords mw INNER JOIN words w ON mw.word_id = w.word_id WHERE mw.visitor_id = ?`;
      params.push(visitor_id);
      if (source_type === "my_words_current") {
        if (!lang_id) return sendError(res, "lang_id zorunlu", 400);
        sql += ` AND mw.lang_id = ?`;
        params.push(lang_id);
      }
    } else {
//2.genel kategori litesi
      if (!lang_id || !category_id) return sendError(res, "lang_id ve category_id zorunlu", 400);
      if (visitor_id) {
//visitor varsa favori kontrolü yaparak getir
        sql = `SELECT w.*, EXISTS (SELECT 1 FROM mywords mw WHERE mw.word_id = w.word_id AND mw.visitor_id = ?) AS is_favorite FROM words w INNER JOIN word_category wc ON w.word_id = wc.word_id WHERE w.lang_id = ? AND wc.category_id = ?`;
        params.push(visitor_id, lang_id, category_id);
      } else {
//visitor yoksa her şeyi favori değil (0) olarak işaretle
        sql = `SELECT w.*, 0 AS is_favorite FROM words w INNER JOIN word_category wc ON w.word_id = wc.word_id WHERE w.lang_id = ? AND wc.category_id = ?`;
        params.push(lang_id, category_id);
      }
    }
//sıralama ve limit eleme
    sql += ` ORDER BY RAND() LIMIT ${limitVal}`;
    const [rows] = await db.execute(sql, params);
    const formattedRows = rows.map(row => ({ ...row, is_favorite: !!row.is_favorite }));
    return sendSuccess(res, formattedRows);
  } catch (err) {
    console.error("WORDS/RANDOM ERROR:", err);
    return sendError(res, "Kelimeler getirilirken hata oluştu.");
  }
});

// 5. MYWORDS/TOGGLE (Senin tüm platform/version/country verilerinle beraber!)
router.post("/mywords/toggle", async (req, res) => {
  let { visitor_id, word_id, lang_id, app_platform, app_version, country } = req.body;
  if (!word_id || !lang_id) return sendError(res, "word_id ve lang_id zorunlu", 400);
  try {
    if (!visitor_id) {
      visitor_id = crypto.randomUUID();
      await db.execute(
        `INSERT INTO visitors (visitor_id, app_platform, app_version, country) VALUES (?, ?, ?, ?)`,
        [visitor_id, app_platform || null, app_version || null, country || null]
      );
    }
    const [existing] = await db.execute("SELECT myword_id FROM mywords WHERE visitor_id = ? AND word_id = ?", [visitor_id, word_id]);
    if (existing.length > 0) {
      await db.execute("DELETE FROM mywords WHERE visitor_id = ? AND word_id = ?", [visitor_id, word_id]);
      return sendSuccess(res, { status: "removed", is_favorite: false, visitor_id });
    } else {
      await db.execute("INSERT INTO mywords (visitor_id, word_id, lang_id) VALUES (?, ?, ?)", [visitor_id, word_id, lang_id]);
      return sendSuccess(res, { status: "added", is_favorite: true, visitor_id });
    }
  } catch (err) {
    return sendError(res, "İşlem başarısız.");
  }
});

// 6. MYWORDS (LIST)
router.get("/mywords/:visitor_id", async (req, res) => {
  const { lang_id } = req.query;
  try {
    let sql = `SELECT w.* FROM mywords mw INNER JOIN words w ON mw.word_id = w.word_id WHERE mw.visitor_id = ?`;
    const params = [req.params.visitor_id];
    if (lang_id && lang_id !== 'all') {
      sql += " AND mw.lang_id = ?";
      params.push(lang_id);
    }
    sql += " ORDER BY mw.myword_id DESC";
    const [rows] = await db.execute(sql, params);
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Liste yüklenemedi.");
  }
});

// 7. VISITORS/INIT
router.post("/visitors/init", async (req, res) => {
  const { visitor_id } = req.body;
  if (!visitor_id) return sendError(res, "ID gerekli", 400);
  try {
    const [rows] = await db.execute("SELECT * FROM visitors WHERE visitor_id = ?", [visitor_id]);
    if (rows.length === 0) return sendError(res, "Bulunamadı", 404);
    return sendSuccess(res, rows[0]);
  } catch (err) {
    return sendError(res, "Sistem başlatılamadı.");
  }
});

app.use('/api/v1', router);
app.listen(3000, "0.0.0.0", () => console.log("WordApp API running on port 3000!"));
