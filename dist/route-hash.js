(() => {
  const target = "/#/inquiries/slenquiry";
  if (window.location.pathname !== "/" || window.location.hash !== "#/inquiries/slenquiry") {
    window.history.replaceState(null, "", target);
  }
})();
