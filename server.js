//node server.js 
//git status
//git add .
//git commit -m "Fix: Veritabani baglantisi ve guvenlik ayarlari guncellendi"
//git push origin main

//require('dotenv').config();
const express = require("express");
const mysql = require("mysql2/promise");
const crypto = require('crypto');
const cors = require("cors");
const rateLimit = require('express-rate-limit');
const app = express();
const router = express.Router();

// Rate Limiter: Geliştirme aşamasında Bolt.new için uygun limitler
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

// Log Helper
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// =========================
// RESPONSE HELPERS
// =========================
const sendSuccess = (res, data, status = 200) => res.status(status).json({ success: true, data });
const sendError = (res, message, status = 500) => res.status(status).json({ success: false, error: { message } });

// DB Bağlantısı
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

// Ana URL: site çalışıyor mu kontrolü
app.get("/", (req, res) => {
  res.send("API çalışıyor");
});

// =========================
// LANGUAGE ENDPOINTS
// =========================

// Header Dropdown: Ana diller listesi
router.get("/my-languages", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT mylang_id, mylang_code, mylang_name FROM mylanguage ORDER BY mylang_name");
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Ana diller listesi alınamadı.");
  }
});

// Header Dropdown: Öğrenilecek diller listesi
router.get("/languages", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT lang_id, lang_code, lang_name FROM language ORDER BY lang_name");
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Diller listesi alınamadı.");
  }
});

// =========================
// CATEGORY ENDPOINTS
// =========================

// Seçili dile göre kategorileri getirir
router.get("/categories", async (req, res) => {
  const { lang_id } = req.query;
  if (!lang_id) return sendError(res, "lang_id zorunlu", 400);

  try {
    const sql = `
      SELECT DISTINCT c.category_id, c.category_name 
      FROM categories c
      INNER JOIN word_category wc ON c.category_id = wc.category_id
      WHERE wc.lang_id = ?
      ORDER BY c.category_name`;
    const [rows] = await db.execute(sql, [lang_id]);
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Kategoriler alınamadı.");
  }
});

// =========================
// WORDS ENDPOINTS
// =========================

// Rastgele Kelime Getir: Uygulamanın ana motoru (Swipe yapınca çalışır)
router.get("/words/random", async (req, res) => {
  const { lang_id, category_id, visitor_id } = req.query;
  if (!lang_id || !category_id) return sendError(res, "Dil ve Kategori seçimi zorunlu", 400);

  try {
    const sql = `
      SELECT w.*, 
      EXISTS(SELECT 1 FROM mywords mw WHERE mw.word_id = w.word_id AND mw.visitor_id = ?) as is_favorite
      FROM words w
      INNER JOIN word_category wc ON w.word_id = wc.word_id
      WHERE w.lang_id = ? AND wc.category_id = ?
      ORDER BY RAND() LIMIT 1`;
    
    const [rows] = await db.execute(sql, [visitor_id || null, lang_id, category_id]);
    if (rows.length === 0) return sendError(res, "Kelime bulunamadı", 404);
    
    return sendSuccess(res, { ...rows[0], is_favorite: Boolean(rows[0].is_favorite) });
  } catch (err) {
    return sendError(res, "Kelime getirilirken hata oluştu.");
  }
});

// ID ile Kelime Detayı (Opsiyonel kullanım için)
router.get("/words/:id", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM words WHERE word_id = ?", [req.params.id]);
    if (rows.length === 0) return sendError(res, "Kelime bulunamadı", 404);
    return sendSuccess(res, rows[0]);
  } catch (err) {
    return sendError(res, "Detay alınamadı.");
  }
});

// =========================
// MYWORDS (FAVORITES) & VISITOR LOGIC
// =========================

// MyWords Toggle: Kullanıcı favoriye bastığında sessizce ID oluşturur ve kelimeyi ekler
router.post("/mywords/toggle", async (req, res) => {
  let { visitor_id, word_id, mylang_id, lang_id } = req.body;

  if (!word_id) return sendError(res, "word_id zorunlu", 400);

  try {
    let isNewVisitor = false;

    // 1. Visitor ID yoksa hemen oluştur ve kaydet
    if (!visitor_id) {
      visitor_id = crypto.randomUUID();
      isNewVisitor = true;
      await db.execute(
        "INSERT INTO visitors (visitor_id, mylang_id, lang_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, NOW(), NOW())",
        [visitor_id, mylang_id || 1, lang_id || 1]
      );
    }

    // 2. Favori kontrolü (Vibe check)
    const [existing] = await db.execute("SELECT myword_id FROM mywords WHERE visitor_id = ? AND word_id = ?", [visitor_id, word_id]);

    if (existing.length > 0) {
      await db.execute("DELETE FROM mywords WHERE visitor_id = ? AND word_id = ?", [visitor_id, word_id]);
      return sendSuccess(res, { status: "removed", is_favorite: false, visitor_id });
    } else {
      await db.execute("INSERT INTO mywords (visitor_id, word_id) VALUES (?, ?)", [visitor_id, word_id]);
      return sendSuccess(res, { status: "added", is_favorite: true, visitor_id, isNewVisitor });
    }
  } catch (err) {
    console.error(err);
    return sendError(res, "İşlem başarısız.");
  }
});

// Sidebar: Kullanıcının favori listesini getirir
router.get("/mywords/:visitor_id", async (req, res) => {
  try {
    const sql = `
      SELECT w.word_id, w.word, w.pronunciation, w.short_definition
      FROM mywords mw
      INNER JOIN words w ON mw.word_id = w.word_id
      WHERE mw.visitor_id = ? ORDER BY mw.myword_id DESC`;
    const [rows] = await db.execute(sql, [req.params.visitor_id]);
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Favori listesi yüklenemedi.");
  }
});

// =========================
// VISITOR INIT
// =========================

// Sadece ID'si olan kullanıcılar için tercihlerini doğrular
router.post("/visitors/init", async (req, res) => {
  const { visitor_id } = req.body;
  if (!visitor_id) return sendError(res, "ID gerekli", 400);

  try {
    const [rows] = await db.execute("SELECT visitor_id, mylang_id, lang_id FROM visitors WHERE visitor_id = ?", [visitor_id]);
    if (rows.length === 0) return sendError(res, "Kullanıcı bulunamadı", 404);
    
    return sendSuccess(res, rows[0]);
  } catch (err) {
    return sendError(res, "Sistem başlatılamadı.");
  }
});

// =========================
// START SERVER
// =========================
app.use('/api/v1', router);
app.listen(3000, "0.0.0.0", () => {
  console.log("Playful API running on port 3000!");
});
