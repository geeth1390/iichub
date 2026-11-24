'use strict';
// Private equipment owners list machines; admins approve them before
// they appear in search.

// Listing machines now lives in routes/listings.js (with photos and procedure).
module.exports = async function ownerRoutes(app, { db, auth }) {
  app.get('/owner/dashboard', { preValidation: auth.guard(['equipment_owner']) }, async (req) =>
    (await db.query('SELECT * FROM v_owner_dashboard WHERE owner_user_id = $1', [req.user.id])).rows);
};
