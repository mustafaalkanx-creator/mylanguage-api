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
      SELECT c.category_id, c.category_name, COUNT(wc.word_id) as word_count
      FROM categories c
      INNER JOIN word_category wc ON c.category_id = wc.category_id
      WHERE wc.lang_id = ? 
      GROUP BY c.category_id, c.category_name
      ORDER BY c.category_id ASC`, [lang_id]);

  //2.grup Kullanıcının kendi listeleri (Favori var mı kontrolü) 
 	let userLists = [
      { id: 'my_words_current', name: 'Kelimelerim (Seçili Dil)', active: false, count: 0 },
      { id: 'my_words_all', name: 'Tüm Kelimelerim', active: false, count: 0 }
    ];
    
 if (visitor_id) {
      const [stats] = await db.execute(`
        SELECT 
          COUNT(CASE WHEN lang_id = ? THEN 1 END) as current_count,
          COUNT(*) as total_count
        FROM mywords WHERE visitor_id = ?`, [lang_id, visitor_id]);
      
      // Eğer veritabanından sonuç geldiyse (stats[0] varsa) değerleri ata
    	if (stats && stats[0]) {
        userLists[0].active = stats[0].current_count > 0;
        userLists[0].count = stats[0].current_count;
        userLists[1].active = stats[0].total_count > 0;
        userLists[1].count = stats[0].total_count;
      }
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

// 5. MYWORDS/TOGGLE (Favori Ekle/Çıkar)
router.post("/mywords/toggle", async (req, res) => {
  let { visitor_id, word_id, lang_id, app_platform, app_version, country } = req.body;

  if (!word_id || !lang_id) return sendError(res, "word_id ve lang_id zorunlu", 400);

  try {
    let isNewUser = false;

    // 1. Eğer Bolt'tan ID gelmemişse, hemen burada oluştur (Güvenlik ağı)
    if (!visitor_id) {
      visitor_id = crypto.randomUUID();
      isNewUser = true;
      await db.execute(
        `INSERT INTO visitors (visitor_id, app_platform, app_version, country) VALUES (?, ?, ?, ?)`,
        [visitor_id, app_platform || 'web', app_version || '1.0.0', country || null]
      );
    }

    // 2. Bu kelime zaten kullanıcının listesinde var mı?
    const [existing] = await db.execute(
      "SELECT myword_id FROM mywords WHERE visitor_id = ? AND word_id = ?", 
      [visitor_id, word_id]
    );

    if (existing.length > 0) {
      // Varsa SİL (Toggle mantığı)
      await db.execute("DELETE FROM mywords WHERE visitor_id = ? AND word_id = ?", [visitor_id, word_id]);
      return sendSuccess(res, { 
        status: "removed", 
        is_favorite: false, 
        visitor_id, // Bolt'a her zaman ID'yi geri gönderiyoruz
        is_new_user: isNewUser 
      });
    } else {
      // Yoksa EKLE
      await db.execute(
        "INSERT INTO mywords (visitor_id, word_id, lang_id) VALUES (?, ?, ?)", 
        [visitor_id, word_id, lang_id]
      );
      return sendSuccess(res, { 
        status: "added", 
        is_favorite: true, 
        visitor_id, 
        is_new_user: isNewUser 
      });
    }
  } catch (err) {
    console.error("TOGGLE ERROR:", err);
    return sendError(res, "İşlem sırasında bir hata oluştu.");
  }
});

// 6. MYWORDS (LIST) - Güncel Versiyon
router.get("/mywords/:visitor_id", async (req, res) => {
  const { lang_id } = req.query;
  try {
    // Sorguya "true AS is_favorite" ekledik, Bolt kartları çizerken "kalp" ikonunu dolu göstersin diye.
    let sql = `SELECT w.*, true AS is_favorite FROM mywords mw 
               INNER JOIN words w ON mw.word_id = w.word_id 
               WHERE mw.visitor_id = ?`;
    
    const params = [req.params.visitor_id];
    
    if (lang_id && lang_id !== 'all') {
      sql += " AND mw.lang_id = ?";
      params.push(lang_id);
    }
    
    sql += " ORDER BY mw.myword_id DESC";
    
    const [rows] = await db.execute(sql, params);
    
    // Veritabanı bazen 1/0 döner, bunu Bolt'un sevdiği gerçek true/false formatına çevirelim
    const formattedRows = rows.map(row => ({ ...row, is_favorite: true }));
    
    return sendSuccess(res, formattedRows);
  } catch (err) {
    console.error("MYWORDS LIST ERROR:", err);
    return sendError(res, "Liste yüklenemedi.");
  }
});

// 7. VISITORS/INIT
// 7. VISITORS/INIT (Geliştirilmiş ve Bolt Uyumlu Hali)
router.post("/visitors/init", async (req, res) => {
  const { visitor_id } = req.body; // Bolt'un çekmecesinden gelen ID

  try {
    // 1. Eğer Bolt bir ID gönderdiyse, veritabanında var mı diye bak
    if (visitor_id) {
      const [rows] = await db.execute("SELECT * FROM visitors WHERE visitor_id = ?", [visitor_id]);
      
      if (rows.length > 0) {
        // Kullanıcıyı bulduk! Eski bilgilerini geri gönderiyoruz.
        return sendSuccess(res, {
          visitor_id: rows[0].visitor_id,
          is_new: false,
          data: rows[0]
        });
      }
    }

    // 2. ID gelmediyse VEYA gönderilen ID veritabanında yoksa (temizlik yapılmışsa)
    const newID = crypto.randomUUID(); // Yepyeni bir kimlik oluştur
    
    await db.execute(
      "INSERT INTO visitors (visitor_id, app_platform) VALUES (?, ?)",
      [newID, req.body.app_platform || 'web']
    );

    // Bolt'a diyoruz ki: "Seni yeni kaydettim, bu ID'yi hafızana al"
    return sendSuccess(res, {
      visitor_id: newID,
      is_new: true,
      data: { visitor_id: newID }
    });

  } catch (err) {
    console.error("INIT ERROR:", err);
    return sendError(res, "Sistem başlatılamadı.");
  }
});

app.use('/api/v1', router);
app.listen(3000, "0.0.0.0", () => console.log("WordApp API running on port 3000!"));
