/**
 * Enterprise WhatsApp Platform config (Part 4) — env-driven, JSON-override
 * pattern matching every other `get*Config()` in this codebase
 * (utils/bookingConfig.js, utils/authConfig.js, ...). Never hardcode these
 * as literals at a call site.
 */
export const getWhatsAppConfig = () => ({
  // Meta's own WhatsApp Business customer-service-window rule — free-form
  // business-initiated messages are only allowed within this many hours of
  // the customer's own last inbound message.
  conversationWindowHours: parseInt(process.env.WHATSAPP_CONVERSATION_WINDOW_HOURS || "24", 10)
});

export default getWhatsAppConfig;
