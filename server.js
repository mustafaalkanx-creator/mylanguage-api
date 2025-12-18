require('dotenv').config();
const express = require("express");
const mysql = require("mysql2/promise");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const app = express();
const router = express.Router();
app.use(express.json());

const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 dakika
  max: 30,             // 1 dakikada en fazla 30 istek
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: "Çok fazla istek, lütfen bekleyin" } }
});
app.use(limiter);

app.use(cors());


// =========================
// Response Helpers
// =========================
const sendSuccess = (res, data, status = 200) => {
  return res.status(status).json({
    success: true,
    data
  });
};

const sendError = (res, message, status = 500) => {
  return res.status(status).json({
    success: false,
    error: {
      message
    }
  });
};

const port = 3000;
// Veritabanı bağlantı ayarları
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Veritabanına bağlanmayı dener
(async () => {
  try {
    const connection = await db.getConnection();
    console.log("MariaDB bağlantısı başarılı");
    connection.release();
  } catch (err) {
    console.error("Veritabanı bağlantı hatası:", err);
  }
})();

// Ana URL: site çalışıyor mu kontrolü
app.get("/", (req, res) => {
  res.send("API çalışıyor");
});

// =========================
// endpointler buranın altına gelecek. 
// =========================

// =========================
// LANGUAGE ENDPOİNTLER
// =========================



// Ana diller listesi
router.get("/my-languages", async (req, res) => {
  try {
    const sql = `
      SELECT 
        mylang_id,
        mylang_code,
        mylang_name
      FROM mylanguage
      ORDER BY mylang_name
    `;

    const [rows] = await db.query(sql);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error(err);
    return sendError(res, "Ana diller alınamadı");
  }
});

// Öğrenilecek diller listesi
router.get("/languages", async (req, res) => {
  try {
    const sql = `
      SELECT 
        lang_id,
        lang_code,
        lang_name
      FROM language
      ORDER BY lang_name
    `;

    const [rows] = await db.query(sql);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error(err);
    return sendError(res, "Diller alınamadı");
  }
});

// =========================
// VİSİTORS ENDPOİNTLER
// =========================

//yeni visitors için endpoint
router.post("/visitors/init", async (req, res) => {
  try {
    const visitorId = uuidv4();

   const sql = `
  INSERT INTO visitors
  (visitor_id, app_platform, app_version, country, mylang_id, lang_id, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
`;

 await db.execute(sql, [
  visitorId,
  "web",        // app_platform
  "1.0.0",      // app_version
  "unknown",    // country
  1,            // mylang_id
  1             // lang_id
]);

 return sendSuccess(res, { visitor_id: visitorId }, 201);

  } catch (error) {
    console.error(error);
    return sendError(res, "Visitor oluşturulamadı");
  }
});


// Visitor dil tercihlerini güncelleme
router.post("/visitors/update-preferences", async (req, res) => {
  const { visitor_id, mylang_id, lang_id } = req.body;

  if (!visitor_id || !mylang_id || !lang_id) {
    return sendError(res, "Eksik parametre", 400);
  }

  try {
    const sql = `
      UPDATE visitors
      SET 
        mylang_id = ?,
        lang_id = ?,
        last_seen_at = NOW()
      WHERE visitor_id = ?
    `;

    const [result] = await db.execute(sql, [
      mylang_id,
      lang_id,
      visitor_id
    ]);

    if (result.affectedRows === 0) {
      return sendError(res, "Visitor bulunamadı", 404);
    }

    return sendSuccess(res, { updated: true });

  } catch (error) {
    console.error(error);
    return sendError(res, "Tercihler güncellenemedi");
  }
});

// Belirli bir visitor'ın bilgilerini ve tercihlerini getir
router.get("/visitors/:visitor_id", async (req, res) => {
  const { visitor_id } = req.params;
  try {
    const [rows] = await db.execute(
      `SELECT visitor_id, mylang_id, lang_id FROM visitors WHERE visitor_id = ?`,
      [visitor_id]
    );

    if (rows.length === 0) {
      return sendError(res, "Kullanıcı bulunamadı", 404);
    }

    return sendSuccess(res, rows[0]);
  } catch (error) {
    console.error(error);
    return sendError(res, "Kullanıcı bilgileri alınamadı");
  }
});

// =========================
// WORDS ENDPOİNTLER
// =========================

//words endpoint'i words tablosundan kelimeleri çeker
router.get("/words/all", async (req, res) => {
  try {
    const sql = `
      SELECT 
        word_id,
        word
      FROM words
      ORDER BY word_id
    `;

    const [rows] = await db.query(sql);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error(err);
    return sendError(res, "Kelimeler alınamadı");
  }
});

// Seçilen dil ve (isteğe bağlı) kategoriye göre RASTGELE tek bir kelime getirir
router.get("/words/random", async (req, res) => {
  const { lang_id, category_id, visitor_id } = req.query; // visitor_id eklendi

  if (!lang_id) {
    return sendError(res, "lang_id zorunlu", 400);
  }

  try {
    let sql = `
      SELECT 
        w.word_id,
        w.word,
        w.pronunciation,
        w.short_definition,
        w.example1,
        w.example2,
        (SELECT COUNT(*) FROM mywords mw WHERE mw.word_id = w.word_id AND mw.visitor_id = ?) as is_favorite
      FROM words w
    `;
    
    // ... join ve filtreleme kısımları aynı kalıyor ...
    // ... sadece params kısmına visitor_id ekliyoruz ...

    const params = [visitor_id || null]; // İlk sıradaki ? için (is_favorite kontrolü)

    if (category_id && category_id !== 'all' && category_id !== '0') {
      sql += `
        INNER JOIN word_category wc ON wc.word_id = w.word_id
        WHERE w.lang_id = ? AND wc.category_id = ?
      `;
      params.push(lang_id, category_id);
    } else {
      sql += ` WHERE w.lang_id = ? `;
      params.push(lang_id);
    }

    sql += ` ORDER BY RAND() LIMIT 1 `;

    const [rows] = await db.execute(sql, params);
    
    if (rows.length === 0) return sendError(res, "Kelime bulunamadı", 404);

    // is_favorite 0'dan büyükse true, değilse false döndür
    const result = {
      ...rows[0],
      is_favorite: rows[0].is_favorite > 0
    };

    return sendSuccess(res, result);

  } catch (err) {
    console.error(err);
    return sendError(res, "Hata oluştu");
  }
});

// words tablosundan word id ye göre, o kelimenin tüm bilgilerini getirir (is_favorite kontrolü ile)
router.get("/words/:id", async (req, res) => {
  const wordId = req.params.id;
  const { visitor_id } = req.query; // Query string'den visitor_id alıyoruz

  if (!wordId) {
    return sendError(res, "word_id zorunlu", 400);
  }

  try {
    const [rows] = await db.execute(
      `
      SELECT 
        w.word_id,
        w.word,
        w.pronunciation,
        w.short_definition,
        w.example1,
        w.example2,
        (SELECT COUNT(*) FROM mywords mw WHERE mw.word_id = w.word_id AND mw.visitor_id = ?) as is_favorite
      FROM words w
      WHERE w.word_id = ?
      `,
      [visitor_id || null, wordId] // visitor_id yoksa null göndererek hata almayı engelliyoruz
    );

    if (rows.length === 0) {
      return sendError(res, "Kelime bulunamadı", 404);
    }

    // is_favorite değerini boolean (true/false) formatına çeviriyoruz
    const result = {
      ...rows[0],
      is_favorite: rows[0].is_favorite > 0
    };

    return sendSuccess(res, result);

  } catch (err) {
    console.error(err);
    return sendError(res, "Kelime bilgileri alınamadı");
  }
});

// Seçilen dil ve (isteğe bağlı) kategoriye göre kelime listesini getirir
router.get("/words", async (req, res) => {
  const { lang_id, category_id } = req.query;

  if (!lang_id) {
    return sendError(res, "lang_id zorunlu", 400);
  }

  try {
    let sql = `
      SELECT DISTINCT
        w.word_id,
        w.word
      FROM words w
    `;
    
    const params = [lang_id];

    // Eğer category_id varsa JOIN ekle ve filtrele
    if (category_id && category_id !== 'all' && category_id !== '0') {
      sql += `
        INNER JOIN word_category wc ON wc.word_id = w.word_id
        WHERE w.lang_id = ? AND wc.category_id = ?
      `;
      params.push(category_id);
    } else {
      // Kategori yoksa sadece dile göre filtrele
      sql += ` WHERE w.lang_id = ? `;
    }

    sql += ` ORDER BY w.word_id `;

    const [rows] = await db.execute(sql, params);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error(err);
    return sendError(res, "Kelimeler yüklenirken hata oluştu");
  }
});


// MyWords ekle / çıkar (toggle)
router.post("/mywords/toggle", async (req, res) => {
  const { visitor_id, word_id } = req.body;

  if (!visitor_id || !word_id) {
    return sendError(res, "visitor_id ve word_id zorunlu", 400);
  }

  try {
    // Kelime daha önce eklenmiş mi?
    const [rows] = await db.execute(
      "SELECT myword_id FROM mywords WHERE visitor_id = ? AND word_id = ?",
      [visitor_id, word_id]
    );

    if (rows.length > 0) {
      // varsa sil
      await db.execute(
        "DELETE FROM mywords WHERE visitor_id = ? AND word_id = ?",
        [visitor_id, word_id]
      );

      return sendSuccess(res, { status: "removed" });

    } else {
      // yoksa ekle
      await db.execute(
        "INSERT INTO mywords (visitor_id, word_id) VALUES (?, ?)",
        [visitor_id, word_id]
      );

      return sendSuccess(res, { status: "added" });
    }
  } catch (err) {
    console.error(err);
    return sendError(res, "MyWords işlem hatası");
  }
});

// Kategori listesi (sidebar için)
router.get("/categories", async (req, res) => {
  try {
    const sql = `
      SELECT
        category_id,
        category_name
      FROM categories
      ORDER BY category_name
    `;

    const [rows] = await db.query(sql);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error(err);
    return sendError(res, "Kategoriler alınamadı");
  }
});


// Kullanıcının kendi kelime listesini getir
router.get("/mywords/:visitor_id", async (req, res) => {
  const { visitor_id } = req.params;

  if (!visitor_id) {
    return sendError(res, "visitor_id zorunlu", 400);
  }

  try {
    const [rows] = await db.execute(
      `
      SELECT 
        w.word_id,
        w.word,
        w.pronunciation,
        w.short_definition,
        w.example1,
        w.example2
      FROM mywords mw
      INNER JOIN words w ON w.word_id = mw.word_id
      WHERE mw.visitor_id = ?
      ORDER BY mw.myword_id DESC
      `,
      [visitor_id]
    );

    return sendSuccess(res, rows);
  } catch (err) {
    console.error(err);
    return sendError(res, "MyWords listesi alınamadı");
  }
});

//tets için eklendi. 
app.get("/test-id/:id", (req, res) => {
  res.send("Gelen ID: " + req.params.id);
});

//versiyon ve router eklenince geldi
app.use('/api/v1', router);

// Server'ı başlatır
app.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000 bu yeni kod çalışıyor.....");
});

