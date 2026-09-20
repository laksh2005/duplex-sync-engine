/**
 * duplex-sync-engine - Google Sheets push trigger
 *
 * Notifies the sync server the moment someone edits the sheet, so a sync runs
 * on the edit instead of waiting for a poll.
 *
 * Setup
 * -----
 * 1. In the Google Sheet: Extensions > Apps Script, and paste this file in.
 * 2. Project Settings > Script Properties, add:
 *      SYNC_WEBHOOK_URL   https://your-server/api/webhook/sheet
 *      SYNC_WEBHOOK_SECRET  (must match WEBHOOK_SECRET on the server)
 * 3. Run installTrigger() once and grant the permissions it asks for.
 *
 * It has to be an INSTALLABLE trigger, not a simple onEdit(e) function: simple
 * triggers run without authorization and are not allowed to call UrlFetchApp.
 * installTrigger() creates the installable one for you.
 */

var THROTTLE_SECONDS = 2;

function installTrigger() {
  var sheet = SpreadsheetApp.getActive();

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(sheet).onEdit().create();

  Logger.log('Installed onEdit trigger for: ' + sheet.getName());
}

function onSheetEdit(e) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SYNC_WEBHOOK_URL');
  var secret = props.getProperty('SYNC_WEBHOOK_SECRET');

  if (!url || !secret) {
    Logger.log('SYNC_WEBHOOK_URL or SYNC_WEBHOOK_SECRET not set; skipping');
    return;
  }

  // A paste or fill-down fires this handler once per edited range. The server
  // dedupes anyway, but throttling here keeps us well inside the Apps Script
  // UrlFetch daily quota.
  var cache = CacheService.getScriptCache();
  if (cache.get('sync_sent')) {
    return;
  }
  cache.put('sync_sent', '1', THROTTLE_SECONDS);

  var payload = {
    changedAt: Date.now(),
    range: e && e.range ? e.range.getA1Notation() : null,
    sheet: e && e.range ? e.range.getSheet().getName() : null
  };

  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-webhook-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    if (code >= 300) {
      Logger.log('Sync webhook returned ' + code + ': ' + response.getContentText());
    }
  } catch (err) {
    // Never let a webhook failure surface as an error in the user's sheet.
    Logger.log('Sync webhook failed: ' + err);
  }
}

/** Fires one test request so you can confirm the wiring without editing a cell. */
function testWebhook() {
  onSheetEdit(null);
  Logger.log('Test webhook sent');
}
