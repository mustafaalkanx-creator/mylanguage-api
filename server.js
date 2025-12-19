//require('dotenv').config();
const express = require("express");
const mysql = require("mysql2/promise");
//const { v4: uuidv4 } = require("uuid");
const crypto = require('crypto');
const cors = require("cors");
const rateLimit = require('express-rate-limit');
const app = express();
const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 60,             // Bolt.new geliştirme aşamasında sayfa çok yenilendiği için 60 daha rahattır.
  standardHeaders: true,
  legacyHeaders: false,
  message: { 
    success: false, 
    error: { message: "Çok fazla istek, lütfen bekleyin" } 
  }
});

app.use(express.json());
// İstekleri takip etmek için basit bir log
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});
app.use(cors());
app.use(limiter);


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

    // İyileştirme: execute kullanımı
    const [rows] = await db.execute(sql); 
    return sendSuccess(res, rows);

  } catch (err) {
    console.error("GET /my-languages Hatası:", err); // Etiket eklendi
    return sendError(res, "Ana diller listesi şu an alınamıyor.");
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

    // İyileştirme: execute kullanımı
    const [rows] = await db.execute(sql);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error("GET /languages Hatası:", err); // Etiket eklendi
    return sendError(res, "Öğrenilecek diller listesi şu an alınamıyor.");
  }
});

// =========================
// VİSİTORS ENDPOİNTLER
// =========================

//yeni veya mevcut visitor için endpoint (Get or Create mantığı)
router.post("/visitors/init", async (req, res) => {
  const { visitor_id, app_platform, app_version, mylang_id, lang_id, country } = req.body;

  try {
    let currentVisitorId = visitor_id;
    // Varsayılan diller veritabanındaki ilk kayıtlar olmalı (genelde 1 ve 2)
    let preferences = { 
      mylang_id: mylang_id || 1, 
      lang_id: lang_id || 2 
    };

    // 1. Ziyaretçi Kontrolü veya Oluşturma
    if (visitor_id && typeof visitor_id === 'string') {
      const [existing] = await db.execute(
        `SELECT visitor_id, mylang_id, lang_id FROM visitors WHERE visitor_id = ?`,
        [visitor_id]
      );

      if (existing.length > 0) {
        // Mevcut kullanıcı: Sadece son görülme tarihini güncelle
        await db.execute(
          `UPDATE visitors SET last_seen_at = NOW() WHERE visitor_id = ?`,
          [visitor_id]
        );
        preferences = { mylang_id: existing[0].mylang_id, lang_id: existing[0].lang_id };
      } else {
        // Geçersiz ID geldiyse yeni oluştur
        currentVisitorId = crypto.randomUUID();
        await createNewVisitor(currentVisitorId);
      }
    } else {
      // ID hiç yoksa yeni oluştur
      currentVisitorId = crypto.randomUUID();
      await createNewVisitor(currentVisitorId);
    }

    async function createNewVisitor(id) {
      const sql = `INSERT INTO visitors (visitor_id, app_platform, app_version, country, mylang_id, lang_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`;
      // Parametrelerin undefined gelme ihtimaline karşı varsayılan değerler
      await db.execute(sql, [
        id, 
        app_platform || "web", 
        app_version || "1.0.0", 
        country || "unknown", 
        preferences.mylang_id, 
        preferences.lang_id
      ]);
    }

    // 2. Bootstrap Verilerini Toplama (Paralel Sorgular - Promise.all ile hızlandırılabilir)
    // Burada hata olasılığına karşı sorguları sarmalıyoruz
    const [myLanguages] = await db.execute(`SELECT mylang_id, mylang_code, mylang_name FROM mylanguage ORDER BY mylang_name`);
    const [languages] = await db.execute(`SELECT lang_id, lang_code, lang_name FROM language ORDER BY lang_name`);
    
    // Kategorileri çekerken dil kontrolü
    const [categories] = await db.execute(`
      SELECT c.category_id, c.category_name, COUNT(wc.word_id) as word_count
      FROM categories c
      LEFT JOIN word_category wc ON c.category_id = wc.category_id
      LEFT JOIN words w ON wc.word_id = w.word_id AND w.lang_id = ?
      GROUP BY c.category_id, c.category_name
    `, [preferences.lang_id]);

    // 3. Başarılı Yanıt
    return sendSuccess(res, { 
      visitor_id: currentVisitorId, 
      preferences,
      initial_data: {
        my_languages: myLanguages,
        languages: languages,
        categories: categories
      }
    });

  } catch (error) {
    // İşte burada hata yönetimi devreye giriyor
    console.error("CRITICAL ERROR: POST /visitors/init:", error);
    return sendError(res, "Sistem başlatılırken teknik bir sorun oluştu. Lütfen daha sonra tekrar deneyin.", 500);
  }
});

// Visitor dil tercihlerini güncelleme
router.post("/visitors/update-preferences", async (req, res) => {
  const { visitor_id, mylang_id, lang_id } = req.body;

  if (!visitor_id || !mylang_id || !lang_id) {
    return sendError(res, "Eksik parametre (id veya dil seçimleri)", 400);
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

    const [result] = await db.execute(sql, [mylang_id, lang_id, visitor_id]);

    if (result.affectedRows === 0) {
      return sendError(res, "Güncellenecek kullanıcı bulunamadı", 404);
    }

    return sendSuccess(res, { updated: true });

  } catch (error) {
    console.error("POST /update-preferences Hatası:", error);
    return sendError(res, "Tercihleriniz kaydedilemedi");
  }
});

// Belirli bir visitor'ın bilgilerini ve tercihlerini getir
router.get("/visitors/:visitor_id", async (req, res) => {
  const { visitor_id } = req.params;

  if (!visitor_id) {
    return sendError(res, "Geçersiz ID", 400);
  }

  try {
    // İyileştirme: JOIN kullanarak dil isimlerini de çekiyoruz
    const sql = `
      SELECT 
        v.visitor_id, 
        v.mylang_id, 
        v.lang_id, 
        v.country,
        ml.mylang_name,
        l.lang_name
      FROM visitors v
      LEFT JOIN mylanguage ml ON v.mylang_id = ml.mylang_id
      LEFT JOIN language l ON v.lang_id = l.lang_id
      WHERE v.visitor_id = ?
    `;

    const [rows] = await db.execute(sql, [visitor_id]);

    if (rows.length === 0) {
      return sendError(res, "Kullanıcı kaydı bulunamadı", 404);
    }

    // UPDATE işlemini buradan kaldırdık, çünkü init endpoint'i bu görevi üstlendi.
    return sendSuccess(res, rows[0]);

  } catch (error) {
    console.error("GET /visitors Hatası:", error);
    return sendError(res, "Kullanıcı bilgileri alınamadı");
  }
});

// =========================
// WORDS ENDPOİNTLER
// =========================

//words endpoint'i seçili dile göre kelimeleri çeker (limitli)
router.get("/words/all", async (req, res) => {
  const { lang_id } = req.query; // Sorgu parametresi olarak lang_id bekliyoruz

  if (!lang_id) {
    return sendError(res, "lang_id parametresi zorunlu", 400);
  }

  try {
    const sql = `
      SELECT 
        word_id,
        word
      FROM words
      WHERE lang_id = ?
      ORDER BY word_id
      LIMIT 100 
    `;

    // İyileştirme: db.execute kullanımı ve parametre bağlama
    const [rows] = await db.execute(sql, [lang_id]);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error("GET /words/all Hatası:", err);
    return sendError(res, "Kelimeler yüklenirken bir hata oluştu");
  }
});

// Seçilen dil, kategori VEYA kullanıcının kendi listesine göre RASTGELE tek bir kelime getirir
router.get("/words/random", async (req, res) => {
  const { lang_id, category_id, visitor_id } = req.query;

  // Güvenlik: visitor_id artık zorunlu çünkü favori kontrolü her durumda lazım
  if (!lang_id || !visitor_id) {
    return sendError(res, "lang_id ve visitor_id parametreleri zorunlu", 400);
  }

  try {
    // 1. Temel Sorgu: is_favorite bilgisini EXISTS ile çekiyoruz
    let sql = `
      SELECT 
        w.word_id,
        w.word,
        w.pronunciation,
        w.short_definition,
        w.example1,
        w.example2,
        EXISTS(SELECT 1 FROM mywords mw WHERE mw.word_id = w.word_id AND mw.visitor_id = ?) as is_favorite
      FROM words w
    `;
    
    const params = [visitor_id];

    // 2. Filtreleme Mantığı (GÜNCELLENDİ)
    if (category_id === 'mywords') {
      // SENARYO A: Kullanıcı sadece kendi eklediği kelimelerden rastgele istiyor
      sql += `
        INNER JOIN mywords mw_list ON mw_list.word_id = w.word_id
        WHERE w.lang_id = ? AND mw_list.visitor_id = ?
      `;
      params.push(lang_id, visitor_id);
    } 
    else if (category_id && category_id !== 'all' && category_id !== '0') {
      // SENARYO B: Belirli bir kategori seçildiyse (Eski mantık)
      sql += `
        INNER JOIN word_category wc ON wc.word_id = w.word_id
        WHERE w.lang_id = ? AND wc.category_id = ?
      `;
      params.push(lang_id, category_id);
    } 
    else {
      // SENARYO C: Tüm kelimeler içinden rastgele (Eski mantık)
      sql += ` WHERE w.lang_id = ? `;
      params.push(lang_id);
    }

    // 3. Sıralama ve Limit
    sql += ` ORDER BY RAND() LIMIT 1 `;

    const [rows] = await db.execute(sql, params);
    
    if (rows.length === 0) {
      let msg = "Bu dilde henüz kelime yok";
      if (category_id === 'mywords') msg = "Çalışma listenizde henüz kelime yok";
      else if (category_id !== 'all') msg = "bu kategoride henüz kelime yok";
      
      return sendError(res, msg, 404);
    }

    const result = {
      ...rows[0],
      is_favorite: Boolean(rows[0].is_favorite)
    };

    return sendSuccess(res, result);

  } catch (err) {
    console.error("GET /words/random Hatası:", err);
    return sendError(res, "Rastgele kelime getirilemedi");
  }
});

// words tablosundan word id ye göre, o kelimenin tüm bilgilerini getirir
router.get("/words/:id", async (req, res) => {
  const wordId = req.params.id;
  const { visitor_id } = req.query; // Kelimenin favori olup olmadığını anlamak için gerekli

  if (!wordId) {
    return sendError(res, "word_id zorunlu", 400);
  }

  try {
    // İyileştirme: execute kullanımı ve EXISTS ile performans artışı
    const sql = `
      SELECT 
        w.word_id,
        w.word,
        w.pronunciation,
        w.short_definition,
        w.example1,
        w.example2,
        EXISTS(SELECT 1 FROM mywords mw WHERE mw.word_id = w.word_id AND mw.visitor_id = ?) as is_favorite
      FROM words w
      WHERE w.word_id = ?
    `;

    const [rows] = await db.execute(sql, [visitor_id || null, wordId]);

    if (rows.length === 0) {
      return sendError(res, "Kelime bulunamadı", 404);
    }

    // is_favorite'i boolean formata çeviriyoruz
    const result = {
      ...rows[0],
      is_favorite: Boolean(rows[0].is_favorite)
    };

    return sendSuccess(res, result);

  } catch (err) {
    console.error("GET /words/:id Hatası:", err);
    return sendError(res, "Kelime detayları yüklenemedi");
  }
});

// Seçilen dil ve (isteğe bağlı) kategoriye göre kelime listesini getirir
router.get("/words", async (req, res) => {
  const { lang_id, category_id } = req.query;

  if (!lang_id) {
    return sendError(res, "lang_id zorunlu", 400);
  }

  try {
    let sql = `SELECT DISTINCT w.word_id, w.word FROM words w`;
    const params = [];

    // Kategoriye göre filtreleme mantığını netleştirelim
    if (category_id && category_id !== 'all' && category_id !== '0') {
      sql += `
        INNER JOIN word_category wc ON wc.word_id = w.word_id
        WHERE w.lang_id = ? AND wc.category_id = ?
      `;
      params.push(lang_id, category_id);
    } else {
      // Kategori seçilmediyse veya 'all' ise sadece dile göre filtrele
      sql += ` WHERE w.lang_id = ? `;
      params.push(lang_id);
    }

    sql += ` ORDER BY w.word_id LIMIT 500`; // MVP için makul bir limit

    const [rows] = await db.execute(sql, params);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error("GET /words Hatası:", err);
    return sendError(res, "Kelimeler listelenirken bir hata oluştu");
  }
});

// MyWords ekle / çıkar (toggle)
router.post("/mywords/toggle", async (req, res) => {
  const { visitor_id, word_id } = req.body;

  if (!visitor_id || !word_id) {
    return sendError(res, "visitor_id ve word_id zorunlu", 400);
  }

  try {
    // 1. Kelime daha önce eklenmiş mi kontrol et (EXISTS daha hızlıdır)
    const [rows] = await db.execute(
      "SELECT myword_id FROM mywords WHERE visitor_id = ? AND word_id = ? LIMIT 1",
      [visitor_id, word_id]
    );

    if (rows.length > 0) {
      // Varsa SİL
      await db.execute(
        "DELETE FROM mywords WHERE visitor_id = ? AND word_id = ?",
        [visitor_id, word_id]
      );

      return sendSuccess(res, { 
        status: "removed", 
        is_favorite: false 
      });

    } else {
      // Yoksa EKLE
      // İyileştirme: Try-catch içinde kalsın ki bir şekilde (duplicate entry) hatası olursa yakalayalım
      await db.execute(
        "INSERT INTO mywords (visitor_id, word_id) VALUES (?, ?)",
        [visitor_id, word_id]
      );

      return sendSuccess(res, { 
        status: "added", 
        is_favorite: true 
      });
    }
  } catch (err) {
    console.error("POST /mywords/toggle Hatası:", err);
    return sendError(res, "Kelime listenize işlenirken bir sorun oluştu.");
  }
});

// Kategori listesi (Kelime sayıları ile birlikte)
router.get("/categories", async (req, res) => {
  const { lang_id } = req.query; // Hangi dildeki sayıları istediğimizi alıyoruz

  if (!lang_id) {
    return sendError(res, "lang_id parametresi zorunlu", 400);
  }

  try {
    const sql = `
      SELECT 
        c.category_id, 
        c.category_name,
        COUNT(wc.word_id) as word_count
      FROM categories c
      LEFT JOIN word_category wc ON c.category_id = wc.category_id
      LEFT JOIN words w ON wc.word_id = w.word_id AND w.lang_id = ?
      GROUP BY c.category_id, c.category_name
      ORDER BY c.category_name
    `;

    const [rows] = await db.execute(sql, [lang_id]);
    return sendSuccess(res, rows);

  } catch (err) {
    console.error("GET /categories Hatası:", err);
    return sendError(res, "Kategoriler ve sayılar alınamadı.");
  }
});

// Kullanıcının kendi kelime listesini getir
router.get("/mywords/:visitor_id", async (req, res) => {
  const { visitor_id } = req.params;

  if (!visitor_id) {
    return sendError(res, "visitor_id zorunlu", 400);
  }

  try {
    const sql = `
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
    `;

    // MyWords listesi genellikle uzun olabilir, execute ile çekiyoruz
    const [rows] = await db.execute(sql, [visitor_id]);

    // Liste boş olsa bile hata değil, boş dizi dönmeliyiz (success: true, data: [])
    return sendSuccess(res, rows);

  } catch (err) {
    console.error("GET /mywords Hatası:", err);
    return sendError(res, "Kelime listeniz yüklenirken bir hata oluştu.");
  }
});

// Kelime Çeviri Proxy (LibreTranslate)
router.post("/translate", async (req, res) => {
  const { text, source_lang, target_lang } = req.body;

  if (!text || !source_lang || !target_lang) {
    return sendError(res, "Eksik parametreler", 400);
  }

  try {
    // Ücretsiz bir LibreTranslate instance'ı kullanıyoruz
    // Not: Uygulama büyüdüğünde buraya kendi API anahtarını veya sunucunu ekleyebilirsin.
    const response = await fetch("https://libretranslate.de/translate", {
      method: "POST",
      body: JSON.stringify({
        q: text,
        source: source_lang, // Örn: "en"
        target: target_lang, // Örn: "tr"
        format: "text"
      }),
      headers: { "Content-Type": "application/json" }
    });

    const data = await response.json();

    if (data.translatedText) {
      return sendSuccess(res, { translated_text: data.translatedText });
    } else {
      throw new Error("Çeviri alınamadı");
    }
  } catch (error) {
    console.error("Translation Error:", error);
    // Hata durumunda kullanıcıya çaktırmadan "Anlamı şu an alınamıyor" diyebiliriz
    return sendError(res, "Şu an çeviri yapılamıyor, lütfen tekrar deneyin.");
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

