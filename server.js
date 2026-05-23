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

// 8. EXPRESSIONS - Kategoriye göre kalıp cümleleri, deyimleri veya günlük ifadeleri getirir
router.get("/expressions/:category_name", async (req, res) => {
  const { category_name } = req.params;

  try {
    // Kategoriye göre filtreleme yapıyoruz
    const query = `
      SELECT expressions_id, exp_category, content 
      FROM expressions 
      WHERE exp_category = ?
      ORDER BY expressions_id ASC
    `;

    const [rows] = await db.execute(query, [category_name]);

    if (rows.length === 0) {
      return sendError(res, "Bu kategoride henüz veri bulunamadı.", 404);
    }

    // MariaDB content sütununu string (text) olarak döndürebilir, 
    // frontend'de uğraşmamak için burada JSON objesine çeviriyoruz.
    const formattedRows = rows.map(row => ({
      id: row.expressions_id,
      category: row.exp_category,
      content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content
    }));

    return sendSuccess(res, formattedRows);
  } catch (err) {
    console.error("Expressions hatası:", err);
    return sendError(res, "İfadeler yüklenirken bir hata oluştu.");
  }
});

// ================================
// VERSION CHECK HELPER
// Versiyonları doğru şekilde karşılaştırır
// Örn: 1.10.0 > 1.2.0 (string hatası olmaz)
// ================================
function isUpdateRequired(current, minimum) {
  const currentParts = current.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);

  for (let i = 0; i < minimumParts.length; i++) {
    const cur = currentParts[i] || 0;
    const min = minimumParts[i];

    // Kullanıcının versiyonu küçükse → güncelleme zorunlu
    if (cur < min) return true;

    // Büyükse → güncel, devam edebilir
    if (cur > min) return false;
  }

  // Tam eşitse → güncel
  return false;
}

// ================================
// ================================
// ================================
// VERSION CHECK ENDPOINT
// Uygulama açılışında çağrılır
// Bolt Frontend { success, data } formatı bekler
// ================================
router.get("/version-check", async (req, res) => {
  // 1. ADIM: Parametreleri Al (Bolt hem 'version' hem de 'v' gönderebilir, ikisini de kontrol ediyoruz)
  const rawPlatform = req.query.platform || "android";
  const userVersion = req.query.version || req.query.v || "0.0.0";

  // 2. ADIM: Platform Normalizasyonu
  const cleanPlatform = rawPlatform.toLowerCase().trim();
  const platform =
    cleanPlatform.includes("ios") ||
    cleanPlatform.includes("iphone") ||
    cleanPlatform.includes("apple")
      ? "ios"
      : "android";

  try {
    // 3. ADIM: Veritabanından Bilgileri Çek
    const [rows] = await db.execute(
      `
      SELECT 
        current_version,
        min_version,
        update_url,
        is_maintenance
      FROM app_versions
      WHERE platform = ?
      LIMIT 1
      `,
      [platform]
    );

    // Platform kaydı yoksa güvenli bir varsayılan dön
    if (!rows.length) {
      return res.json({
        success: true,
        data: {
          is_maintenance: false,
          force_update: false,
          latest_version: userVersion,
          update_url: "",
          message: ""
        }
      });
    }

    const dbData = rows[0];

    // 4. ADIM: Versiyon Karşılaştırması (Zorunlu Güncelleme Kontrolü)
    // isUpdateRequired fonksiyonunun kodunun üst kısımlarında tanımlı olduğundan emin ol
    const forceUpdate = isUpdateRequired(userVersion, dbData.min_version);

    // 5. ADIM: Bolt'un Beklediği Tam Format
    return res.json({
      success: true,
      data: {
        // Bakım modu (Veritabanında 1 ise true, 0 ise false döner)
        is_maintenance: Boolean(dbData.is_maintenance),

        // Zorunlu güncelleme durumu
        force_update: forceUpdate,

        // En son sürüm numarası
        latest_version: dbData.min_version,

        // Mağaza linki
        update_url: dbData.update_url || "",

        // Kullanıcıya gösterilecek dinamik mesaj
        message: dbData.is_maintenance
          ? "Uygulama şu anda bakımda. Lütfen daha sonra tekrar deneyin."
          : forceUpdate
          ? "Yeni bir güncelleme mevcut. Devam etmek için lütfen uygulamayı güncelleyin."
          : ""
      }
    });

  } catch (err) {
    console.error("VERSION CHECK HATASI:", err);

    // Hata durumunda uygulamanın çökmemesi için en azından boş bir data dön
    return res.status(500).json({
      success: false,
      error: {
        message: "Versiyon kontrolü sırasında bir sunucu hatası oluştu."
      }
    });
  }
});

//YENİ ODAAAAAAAAAAAAAAAAAAAA///////////////////////////////////////////
const routerv2 = express.Router();
// yeni endpountler
// 1. MAIN-LANGUAGES (Sıralama ID'ye göre)
routerv2.get("/main-languages", async (req, res) => {
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
routerv2.get("/target-languages", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT target_lang_id, target_lang_name FROM target_lang ORDER BY target_lang_id ASC"
    );
    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Target languages list could not be retrieved.");
  }
});

// 3. CATEGORIES (Seçilen Hedef Dile Göre Filtrelenmiş) //Güncellendi bu kısım.
routerv2.get("/categories", async (req, res) => {
  try {
    // Frontend'den gelen target_lang_id değerini alıyoruz (Örn: /categories?target_lang_id=2)
    const { target_lang_id } = req.query;

    // Eğer kullanıcı bir dil id'si göndermediyse hata dönüyoruz
    if (!target_lang_id) {
      return sendError(res, "target_lang_id parametresi zorunludur.");
    }

    // Sadece o dile ait olan kategorileri getiriyoruz
    const [rows] = await db.execute(
      "SELECT category_id, category_name FROM category WHERE target_lang_id = ? ORDER BY category_id ASC",
      [target_lang_id]
    );

    return sendSuccess(res, rows);
  } catch (err) {
    return sendError(res, "Categories list could not be retrieved.");
  }
});

// 4. MODULES - Modülleri listeler (Learn, Test vb.)
routerv2.get("/modules", async (req, res) => {
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
routerv2.post("/word-stream", async (req, res) => {
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
routerv2.get("/word-meaning/:word_id/:main_lang_id", async (req, res) => {
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
routerv2.get("/ad-settings", async (req, res) => {
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

// 8. EXPRESSIONS - Kategoriye göre kalıp cümleleri, deyimleri veya günlük ifadeleri getirir
routerv2.get("/expressions/:category_name", async (req, res) => {
  const { category_name } = req.params;

  try {
    // Kategoriye göre filtreleme yapıyoruz
    const query = `
      SELECT expressions_id, exp_category, content 
      FROM expressions 
      WHERE exp_category = ?
      ORDER BY expressions_id ASC
    `;

    const [rows] = await db.execute(query, [category_name]);

    if (rows.length === 0) {
      return sendError(res, "Bu kategoride henüz veri bulunamadı.", 404);
    }

    // MariaDB content sütununu string (text) olarak döndürebilir, 
    // frontend'de uğraşmamak için burada JSON objesine çeviriyoruz.
    const formattedRows = rows.map(row => ({
      id: row.expressions_id,
      category: row.exp_category,
      content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content
    }));

    return sendSuccess(res, formattedRows);
  } catch (err) {
    console.error("Expressions hatası:", err);
    return sendError(res, "İfadeler yüklenirken bir hata oluştu.");
  }
});

// ================================
// VERSION CHECK HELPER
// Versiyonları doğru şekilde karşılaştırır
// Örn: 1.10.0 > 1.2.0 (string hatası olmaz)
// ================================
function isUpdateRequired(current, minimum) {
  const currentParts = current.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);

  for (let i = 0; i < minimumParts.length; i++) {
    const cur = currentParts[i] || 0;
    const min = minimumParts[i];

    // Kullanıcının versiyonu küçükse → güncelleme zorunlu
    if (cur < min) return true;

    // Büyükse → güncel, devam edebilir
    if (cur > min) return false;
  }

  // Tam eşitse → güncel
  return false;
}

// ================================
// ================================
// ================================
// VERSION CHECK ENDPOINT
// Uygulama açılışında çağrılır
// Bolt Frontend { success, data } formatı bekler
// ================================
routerv2.get("/version-check", async (req, res) => {
  // 1. ADIM: Parametreleri Al (Bolt hem 'version' hem de 'v' gönderebilir, ikisini de kontrol ediyoruz)
  const rawPlatform = req.query.platform || "android";
  const userVersion = req.query.version || req.query.v || "0.0.0";

  // 2. ADIM: Platform Normalizasyonu
  const cleanPlatform = rawPlatform.toLowerCase().trim();
  const platform =
    cleanPlatform.includes("ios") ||
    cleanPlatform.includes("iphone") ||
    cleanPlatform.includes("apple")
      ? "ios"
      : "android";

  try {
    // 3. ADIM: Veritabanından Bilgileri Çek
    const [rows] = await db.execute(
      `
      SELECT 
        current_version,
        min_version,
        update_url,
        is_maintenance
      FROM app_versions
      WHERE platform = ?
      LIMIT 1
      `,
      [platform]
    );

    // Platform kaydı yoksa güvenli bir varsayılan dön
    if (!rows.length) {
      return res.json({
        success: true,
        data: {
          is_maintenance: false,
          force_update: false,
          latest_version: userVersion,
          update_url: "",
          message: ""
        }
      });
    }

    const dbData = rows[0];

    // 4. ADIM: Versiyon Karşılaştırması (Zorunlu Güncelleme Kontrolü)
    // isUpdateRequired fonksiyonunun kodunun üst kısımlarında tanımlı olduğundan emin ol
    const forceUpdate = isUpdateRequired(userVersion, dbData.min_version);

    // 5. ADIM: Bolt'un Beklediği Tam Format
    return res.json({
      success: true,
      data: {
        // Bakım modu (Veritabanında 1 ise true, 0 ise false döner)
        is_maintenance: Boolean(dbData.is_maintenance),

        // Zorunlu güncelleme durumu
        force_update: forceUpdate,

        // En son sürüm numarası
        latest_version: dbData.min_version,

        // Mağaza linki
        update_url: dbData.update_url || "",

        // Kullanıcıya gösterilecek dinamik mesaj
        message: dbData.is_maintenance
          ? "Uygulama şu anda bakımda. Lütfen daha sonra tekrar deneyin."
          : forceUpdate
          ? "Yeni bir güncelleme mevcut. Devam etmek için lütfen uygulamayı güncelleyin."
          : ""
      }
    });

  } catch (err) {
    console.error("VERSION CHECK HATASI:", err);

    // Hata durumunda uygulamanın çökmemesi için en azından boş bir data dön
    return res.status(500).json({
      success: false,
      error: {
        message: "Versiyon kontrolü sırasında bir sunucu hatası oluştu."
      }
    });
  }
});


//yeni endpointlerin sonu

app.use('/api/v1', router);
app.use('/api/v2', routerv2);
app.listen(3000, "0.0.0.0", () => console.log("WordApp API running on port 3000!"));
