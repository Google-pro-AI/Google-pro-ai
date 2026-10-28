/* ============================================================
   LEGAL PAGES CONFIG — edit these values once, all 4 pages update
   After editing, change ?v=3 to ?v=4 at the bottom of the 4 policy pages.
   ============================================================ */
const LEGAL = {
  brandName:      "AI Pro Pass",
  siteUrl:        "https://aipropass.online/",
  companyName:    "AI Pro Pass",
  companyAddress: "",                           // leave "" to hide it
  registration:   "",                           // leave "" to hide it
  supportEmail:   "support@aipropass.online",
  whatsappNumber: "447378106036",               // digits only
  whatsappLabel:  "+44 7378 106036",            // how the number is shown
  price:          "$9.99",
  governingLaw:   "the Kingdom of Morocco",
  courts:         "the competent courts of Casablanca, Morocco",
  paymentProcessor: "Stripe",
  effectiveDate:  "October 24, 2026"
};

(function(){
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
