/**
 * 试听文本生成（按音色 locale 选择对应语言）
 *
 * 中文音色用中文，其他语言优先用本地语言（更好展示音色特色），
 * 未覆盖的 locale 回退到英语。
 *
 * ⚠️ 本文件与下列文件保持逻辑一致，改动时需同步：
 *    - momovoicesub-cloud/packages/api/src/services/preview.ts  (后端预生成)
 *    - apps/com.momo.voicesub.dr/lib/preview-text.js            (DR 插件)
 *
 * 这样云端预生成音频（后端合成）与本地自填 key 合成的试听文本完全统一，
 * 缓存 key 也一致，避免"同音色不同文本"导致的缓存失效或语义错位。
 */

const LOCALE_PREVIEW_TEXTS: Record<string, (name: string) => string> = {
  'ja-JP': (n) => `こんにちは、もも配音アシスタントをご利用いただきありがとうございます。${n}がお手伝いいたします。`,
  'ko-KR': (n) => `안녕하세요, 모모 더빙 어시스턴트를 이용해 주셔서 감사합니다. ${n}이(가) 도와드리겠습니다.`,
  'vi-VN': (n) => `Xin chào, cảm ơn bạn đã sử dụng Trợ lý Giọng nói MOMO. ${n} rất vui được phục vụ bạn.`,
  'th-TH': (n) => `สวัสดีค่ะ ขอบคุณที่ใช้ผู้ช่วยพากย์เสียง MOMO ${n} พร้อมให้บริการคุณ`,
  'id-ID': (n) => `Halo, terima kasih telah menggunakan Asisten Suara MOMO. ${n} senang dapat melayani Anda.`,
  'ms-MY': (n) => `Helo, terima kasih kerana menggunakan Pembantu Suara MOMO. ${n} gembira dapat berkhidmat kepada anda.`,
  'tr-TR': (n) => `Merhaba, MOMO Sesli Asistanı kullandığınız için teşekkürler. ${n} size hizmet etmekten memnuniyet duyar.`,
  'hu-HU': (n) => `Helló, köszönjük, hogy a MOMO Hangasszisztenst használja. ${n} örömmel áll rendelkezésére.`,
  'de-DE': (n) => `Hallo, danke, dass Sie den MOMO-Sprachassistenten verwenden. ${n} freut sich, Ihnen zu dienen.`,
  'fr-FR': (n) => `Bonjour, merci d'utiliser l'assistant vocal MOMO. ${n} est ravi de vous servir.`,
  'es-ES': (n) => `Hola, gracias por usar el asistente de voz MOMO. ${n} está encantado de servirte.`,
  'pt-BR': (n) => `Olá, obrigado por usar o assistente de voz MOMO. ${n} tem o prazer de te servir.`,
  'it-IT': (n) => `Ciao, grazie per utilizzare l'assistente vocale MOMO. ${n} è lieto di servirti.`,
  'ru-RU': (n) => `Здравствуйте, спасибо за использование голосового помощника MOMO. ${n} рад служить вам.`,
  'pl-PL': (n) => `Cześć, dziękujemy za korzystanie z asystenta głosowego MOMO. ${n} chętnie Ci pomoże.`,
  'nl-NL': (n) => `Hallo, bedankt voor het gebruik van de MOMO-spraakassistent. ${n} staat graag voor u klaar.`,
  'sv-SE': (n) => `Hej, tack för att du använder MOMO-röstassistenten. ${n} är glad att hjälpa dig.`,
  'ar-SA': (n) => `مرحبا، شكرا لاستخدام مساعد الصوت MOMO. ${n} سعيد بخدمتك.`,
  'hi-IN': (n) => `नमस्ते, MOMO वॉइस असिस्टेंट का उपयोग करने के लिए धन्यवाद। ${n} आपकी सेवा करने में प्रसन्न है।`,
};

/**
 * 生成试听文本。
 */
export function buildPreviewText(voice: {
  locale?: string;
  localName?: string;
  displayName?: string;
  shortName?: string;
}): string {
  const { locale, localName, displayName } = voice || {};
  const isChinese = !!locale && (
    String(locale).startsWith('zh-') ||
    String(locale).startsWith('yue-') ||
    String(locale).startsWith('wuu-')
  );
  const rawName = localName || displayName || '';
  // 移除技术后缀（Dragon、HD、Flash、Latest 等），避免 TTS 读出奇怪词语
  const cleanName = rawName
    .replace(/\b(Dragon|HD|Flash|Latest|Neural|Multilingual|Online|TTS|V\d+|\d+[KkMm]Hz)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (isChinese) {
    return `你好，感谢使用默默配音助手，${cleanName}很高兴为你服务。`;
  }

  // 有 locale 专属文本的用它（更好展示音色特色）
  if (locale && LOCALE_PREVIEW_TEXTS[locale]) {
    return LOCALE_PREVIEW_TEXTS[locale](cleanName);
  }

  // 回退：英语
  return `Hello, thank you for using MOMO VoiceSub. ${cleanName} is very glad to serve you.`;
}

export { LOCALE_PREVIEW_TEXTS };
