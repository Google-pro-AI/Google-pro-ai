/* ============================================================
   LEGAL PAGES CONFIG — edit these values once, all 4 pages update
   (keep them identical to the CONFIG block in index.html)
   ============================================================ */
const LEGAL = {
  brandName:      "AI Pro Pass",
  siteUrl:        "https://aipropass.online",
  companyName:    "Your Company Name",          // registered legal name
  companyAddress: "Your business address",
  registration:   "RC / ICE number",            // company registration number
  supportEmail:   "support@yourdomain.com",
  whatsappNumber: "212600000000",               // digits only
  price:          "$19.99",
  governingLaw:   "the Kingdom of Morocco",
  courts:         "the competent courts of Casablanca, Morocco",
  paymentProcessor: "our payment provider",    // e.g. "Stripe", "Paddle", "PayPal"
  effectiveDate:  "October 18, 2026"
};

(function(){
  const fill = (sel, v) => document.querySelectorAll(sel).forEach(e => e.textContent = v);
  Object.keys(LEGAL).forEach(k => fill('[data-l="' + k + '"]', LEGAL[k]));
  document.querySelectorAll('[data-l-email]').forEach(a => { a.textContent = LEGAL.supportEmail; a.href = 'mailto:' + LEGAL.supportEmail; });
  document.querySelectorAll('[data-l-wa]').forEach(a => a.href = 'https://wa.me/' + LEGAL.whatsappNumber);
  document.querySelectorAll('[data-l-site]').forEach(a => { a.textContent = LEGAL.siteUrl.replace(/^https?:\/\//,''); a.href = LEGAL.siteUrl; });
  document.title = document.title.replace('AI Pro Pass', LEGAL.brandName);
})();
