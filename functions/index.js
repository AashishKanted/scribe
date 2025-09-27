const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {GoogleGenerativeAI} = require("@google/generative-ai");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// --- AI Client Initialization ---
const MODEL_NAME = "gemini-2.5-flash-preview-05-20";
const API_KEY = functions.config().gemini.key;

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({
  model: MODEL_NAME,
});

/**
 * AI Scribe: Takes a raw note and enhances it.
 */
exports.getEnhancedReceipt = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Auth required.");
  }
  const {uid} = context.auth.token;
  const {text: rawText} = data;
  if (!rawText) {
    throw new functions.https.HttpsError("invalid-argument", "Text required.");
  }

  try {
    const memoryRef = db.doc(`users/${uid}/memory/summary`);
    const memoryDoc = await memoryRef.get();
    const memorySummary = memoryDoc.exists ?
      memoryDoc.data().summary :
      "No long-term memory yet.";

    const receiptsRef = db
        .collection(`users/${uid}/receipts`)
        .orderBy("timestamp", "desc")
        .limit(3);
    const snapshot = await receiptsRef.get();
    const recentReceipts = [];
    snapshot.forEach((doc) => recentReceipts.push(doc.data()));
    const contextHistory = recentReceipts
        .reverse()
        .map((r) => `- ${r.message}`)
        .join("\n");

    const prompt = `You are a personal scribe with a witty, slightly playful,
and very human tone. Your goal is to rephrase the user's raw note into a
beautifully written, insightful journal entry. The final output must be a
single paragraph under 200 characters. Use the following long-term memory
and recent entries for deep context, but don't feel obligated to reference
them directly. Focus on making the new entry shine.

LONG-TERM MEMORY:
${memorySummary}

RECENT ENTRIES:
${contextHistory || "No recent entries."}

NEW NOTE: "${rawText}"`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return {text: response.text()};
  } catch (error) {
    functions.logger.error("CRITICAL: Gemini API Error in Scribe:", error);
    throw new functions.https.HttpsError("internal", "AI Scribe failed.");
  }
});

/**
 * Memory Curator: Automatically updates the user's long-term memory.
 */
exports.updateMemoryOnNewReceipt = functions.firestore
    .document("users/{userId}/receipts/{receiptId}")
    .onCreate(async (snap, context) => {
      const {userId} = context.params;
      const userRef = db.doc(`users/${userId}`);

      return db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        const currentCount = userDoc.exists ?
          userDoc.data().receiptCount || 0 :
          0;
        const newCount = currentCount + 1;
        transaction.set(userRef, {receiptCount: newCount}, {merge: true});

        if (newCount % 5 !== 0) return null;

        const receiptsQuery = db
            .collection(`users/${userId}/receipts`)
            .orderBy("timestamp", "desc")
            .limit(15);
        const receiptsSnap = await receiptsQuery.get();
        const recentHistory = receiptsSnap.docs
            .map((d) => `- ${d.data().message}`)
            .reverse()
            .join("\n");

        const memoryRef = db.doc(`users/${userId}/memory/summary`);
        const memoryDoc = await memoryRef.get();
        const currentMemory = memoryDoc.exists ? memoryDoc.data().summary : "";

        const prompt = `You are an intelligent memory archivist. Your task is to
update the user's long-term memory summary. Here is the current summary and a
list of their recent journal entries. Synthesize the new entries into the
existing summary, creating a new, cohesive narrative. Intelligently integrate
new facts, remove outdated or trivial details, and identify evolving themes.
The final summary should be a concise, high-level overview of the user's
current life, under 2000 characters. Output only the updated summary.

CURRENT SUMMARY:
${currentMemory || "No summary yet."}

NEW ENTRIES:
${recentHistory}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return transaction.set(memoryRef, {
          summary: response.text(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    });

/**
 * Securely edits a user's receipt.
 */
exports.editReceipt = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Auth required.");
  }
  const {uid} = context.auth.token;
  const {receiptId, newText} = data;
  if (!receiptId || !newText) {
    throw new functions.https.HttpsError("invalid-argument", "ID/Text needed.");
  }

  const receiptRef = db.doc(`users/${uid}/receipts/${receiptId}`);
  await receiptRef.update({message: newText});
  return {status: "success", message: "Receipt updated."};
});

/**
 * Securely deletes a user's receipt.
 */
exports.deleteReceipt = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Auth required.");
  }
  const {uid} = context.auth.token;
  const {receiptId} = data;
  if (!receiptId) {
    throw new functions.https.HttpsError("invalid-argument", "ID needed.");
  }

  const receiptRef = db.doc(`users/${uid}/receipts/${receiptId}`);
  await receiptRef.delete();
  return {status: "success", message: "Receipt deleted."};
});
