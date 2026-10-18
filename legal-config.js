/* ============================================================
   LEGAL PAGES CONFIG — edit these values once, all 4 pages update
   (keep them identical to the CONFIG block in index.html)
   ============================================================ */
const LEGAL = {
  brandName:      "AI Pro Pass",
  siteUrl:        "https://aipropass.online/",
  companyName:    "AI Pro Pass",                // registered legal name
  companyAddress: "",                           // leave "" to hide it
  registration:   "",                           // RC / ICE number — leave "" to hide it
  supportEmail:   "support@aipropass.online",
  whatsappNumber: "212682685845",               // digits only
  whatsappLabel:  "+212 682-685845",            // how the number is shown
  price:          "$19.99",
  governingLaw:   "the Kingdom of Morocco",
  courts:         "the competent courts of Casablanca, Morocco",
  paymentProcessor: "our payment provider",    // e.g. "Stripe", "Paddle", "PayPal"
  effectiveDate:  "October 18, 2026"
};

(function(){
  // fill values; if a value is empty, hide it (and its whole line when marked with data-l-wrap)
  Object.keys(LEGAL).forEach(k => {
    document.querySelectorAll('[data-l="' + k + '"]').forEach(e => {
      const v = LEGAL[k];
      if (v) { e.textContent = v; return; }
      const wrap = e.closest('[data-l-wrap]');
      (wrap || e).remove();
    });
  });
  document.querySelectorAll('[data-l-email]').forEach(a => { a.textContent = LEGAL.supportEmail; a.href = 'mailto:' + LEGAL.supportEmail; });
  document.querySelectorAll('[data-l-wa]').forEach(a => { a.href = 'https://wa.me/' + LEGAL.whatsappNumber; a.textContent = LEGAL.whatsappLabel; });
  document.querySelectorAll('[data-l-site]').forEach(a => { a.textContent = LEGAL.siteUrl.replace(/^https?:\/\//,'').replace(/\/$/,''); a.href = LEGAL.siteUrl; });
  document.title = document.title.replace('AI Pro Pass', LEGAL.brandName);
})();
