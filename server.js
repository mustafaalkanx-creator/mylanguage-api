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

// --- GÜVENLİK KİLİDİ BAŞLANGICI ---
app.use((req, res, next) => {
  // 1. Tarayıcıdan girdiğinde "API çalışıyor" yazısını görebilmen için muafiyet
  if (req.path === "/") return next();

  // 2. Gelen isteğin içindeki anahtarı oku
  const clientKey = req.headers['x-api-key'];
  
  // 3. Coolify'dan gelecek olan ana anahtarı al
  const masterKey = process.env.MOBILE_APP_SECRET;

  // 4. Karşılaştır
  if (clientKey && clientKey === masterKey) {
    next(); // Anahtar doğru, geçebilirsin
  } else {
    // Anahtar hatalıysa veritabanına ulaşmadan burada durdurur
    res.status(403).json({ 
      success: false, 
      error: { message: "Giriş yasak: Geçersiz API Key" } 
    });
  }
});
// --- GÜVENLİK KİLİDİ BİTİŞİ ---

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

// OpenAI Anahtarını tanımla (Coolify'dan gelecek)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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


// 7. AD SETTINGS - Uygulama açılışında reklam ayarlarını ve ID'lerini gönderir
router.get("/ad-settings", async (req, res) => {
  // 1. ADIM: Uygulamadan gelen platform bilgisini al ve temizle
  // Eğer boş gelirse varsayılan olarak 'android' kabul et
  const rawPlatform = req.query.platform || 'android';
  const cleanPlatform = rawPlatform.toLowerCase().trim();

  // 2. ADIM: Platform "zırhı" (Gelen veri ne olursa olsun ios veya android'e eşitle)
  let platform = 'android';
  if (cleanPlatform.includes('ios') || cleanPlatform.includes('apple') || cleanPlatform.includes('iphone')) {
    platform = 'ios';
  }

  try {
    // 3. ADIM: Veritabanından sadece o platforma ait reklamları çek
    const query = `
      SELECT ad_type, is_active, unit_id, step_count 
      FROM ad_settings 
      WHERE platform = ?
    `;
    const [rows] = await db.execute(query, [platform]);

    // 4. ADIM: Gelen veriyi parçala (Find metodu ile ilgili reklamı buluyoruz)
    // Eğer veritabanında o satır yoksa uygulamanın çökmemesi için varsayılan değerler atıyoruz
    const bannerData = rows.find(r => r.ad_type === 'banner') || { is_active: 0, unit_id: "" };
    const rewardedData = rows.find(r => r.ad_type === 'rewarded') || { is_active: 0, unit_id: "", step_count: 5 };

    // 5. ADIM: Bolt (Frontend) için tertemiz bir paket hazırla
    const finalResponse = {
      banner: {
        active: Boolean(bannerData.is_active), // 1'i true, 0'ı false yapar
        id: bannerData.unit_id
      },
      rewarded: {
        active: Boolean(rewardedData.is_active),
        id: rewardedData.unit_id,
        step: rewardedData.step_count // Kaç kelimede bir çıkacağı
      }
    };

    // 6. ADIM: Senin sendSuccess yardımcı fonksiyonunla yanıtı gönder
    return sendSuccess(res, finalResponse);

  } catch (err) {
    console.error("Reklam ayarları hatası:", err);
    return sendError(res, "Reklam ayarları yüklenirken teknik bir hata oluştu.");
  }
});

// 8. VERSIONS CHECK - Uygulama açılışında versiyon kontrol yapıyor.  
router.get("/version-check", async (req, res) => {
  console.log("=== VERSION CHECK ENDPOINT ÇAĞRILDI ===");
  console.log("GELEN QUERY:", req.query);
  // 1. ADIM: Gelen verileri al ve temizle
  const rawPlatform = req.query.platform || 'android';
  const userVersion = req.query.v || '1.0.0'; // Uygulamanın gönderdiği mevcut versiyon
  const cleanPlatform = rawPlatform.toLowerCase().trim();

  // 2. ADIM: Platform "zırhı" (Hatalı yazımları ios/android'e sabitler)
  let platform = 'android';
  if (cleanPlatform.includes('ios') || cleanPlatform.includes('apple') || cleanPlatform.includes('iphone')) {
    platform = 'ios';
  }

  try {
    // 3. ADIM: Veritabanından platform bilgilerini çek
    const query = `
      SELECT current_version, min_version, update_url, is_maintenance 
      FROM app_versions 
      WHERE platform = ?
    `;
    const [rows] = await db.execute(query, [platform]);

    if (rows.length === 0) {
      return sendError(res, "Platform configuration not found.", 404);
    }

    const dbData = rows[0];

    // 4. ADIM: Versiyon Karşılaştırma (Zorunlu Güncelleme Kontrolü)
    // Eğer kullanıcının versiyonu, veritabanındaki minimum versiyondan küçükse TRUE döner.
    // Örnek: userVersion "1.0.0" < min_version "1.1.0" => force_update: true
    const forceUpdate = userVersion < dbData.min_version;

    // 5. ADIM: Yanıt Paketini Hazırla
    const versionStatus = {
      is_maintenance: Boolean(dbData.is_maintenance), // Bakım modu açık mı?
      force_update: forceUpdate,                     // Zorunlu güncelleme var mı?
      latest_version: dbData.current_version,        // Market'teki en son sürüm ne?
      update_url: dbData.update_url,                 // Mağaza linki
      message: dbData.is_maintenance 
        ? "Şu an bakımdayız, kısa süre sonra tekrar deneyin." 
        : (forceUpdate ? "Devam etmek için uygulamayı güncellemeniz gerekiyor." : "Sürümünüz güncel.")
    };

    return sendSuccess(res, versionStatus);

  } catch (err) {
    console.error("Versiyon kontrol hatası:", err);
    return sendError(res, "Sunucu versiyon kontrolü yapamadı.");
  }
});

app.use('/api/v1', router);
app.listen(3000, "0.0.0.0", () => console.log("WordApp API running on port 3000!"));
