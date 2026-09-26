// Configuración de Firebase (Firestore) para la sincronización en la nube.
// Proyecto PROPIO de NutriPath (nutripath-e5248), separado de DGT. Estas claves
// son públicas por diseño; la seguridad se aplica con las Reglas de Firestore.
// Si Firebase no carga (sin internet), la app sigue en local con localStorage.
(function () {
  try {
    if (typeof firebase === "undefined") return; // sin SDK (offline): modo local
    var firebaseConfig = {
      apiKey: "AIzaSyA3JCu-svn6dw42S1geknmgKB9aT22WnJU",
      authDomain: "nutripath-e5248.firebaseapp.com",
      projectId: "nutripath-e5248",
      storageBucket: "nutripath-e5248.firebasestorage.app",
      messagingSenderId: "654637305621",
      appId: "1:654637305621:web:fe934540448644b9f9231c",
    };
    firebase.initializeApp(firebaseConfig);
    window._db = firebase.firestore();
    try { window._db.enablePersistence({ synchronizeTabs: true }).catch(function () {}); } catch (_) {}
  } catch (e) {
    console.warn("Firebase no disponible, se usa solo almacenamiento local:", e);
  }
})();
