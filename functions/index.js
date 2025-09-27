const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {GoogleGenerativeAI} = require("@google/generative-ai");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Initialize Google AI Client
const MODEL_NAME = "gemini-2.5-flash-preview-05-20";
const API_KEY = functions.config().gemini.key;

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({model: MODEL_NAME});

/**
 * Takes a raw note and uses AI to enhance it, using both long-term memory
 * and recent receipts for context.
 */
exports.getEnhancedReceipt = functions.https.onCall(async (data, context) => {
  // Authentication check
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be logged in to use the AI Scribe.",
    );
  }

  const {text: rawText} = data;
  const {uid} = context.auth.token;

  if (!rawText) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "The function must be called with 'text' containing the message.",
    );
  }

  try {
    // 1. Fetch long-term memory
    const memoryRef = db.doc(`users/${uid}/memory/summary`);
    const memoryDoc = await memoryRef.get();
    const memorySummary = memoryDoc.exists() ?
      memoryDoc.data().summary :
      "No long-term memory yet.";

    // 2. Fetch recent receipts for short-term context
    const receiptsRef = db
        .collection(`users/${uid}/receipts`)
        .orderBy("timestamp", "desc")
        .limit(3);
    const snapshot = await receiptsRef.get();
    const recentReceipts = [];
    snapshot.forEach((doc) => {
      recentReceipts.push(doc.data());
    });
    const contextHistory = recentReceipts
        .reverse()
        .map((r) => `- ${r.message}`)
        .join("\n");

    // 3. Construct the detailed prompt
    const prompt = `You are a supportive biographer. Expand the following raw
note into a reflective journal entry. The final output must be a single
paragraph under 200 characters.

Use the following long-term memory and recent entries for deep context.

LONG-TERM MEMORY:
${memorySummary}

RECENT ENTRIES:
${contextHistory || "No recent entries."}

NEW NOTE: "${rawText}"`;


    // 4. Call the Gemini API and return the result
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const enhancedText = response.text();
    return {text: enhancedText};
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw new functions.https.HttpsError(
        "internal",
        "Failed to get a response from the AI Scribe.",
    );
  }
});

/**
 * Automatically updates the user's long-term memory file
 * after every 5 new receipts are created.
 */
exports.updateMemoryOnNewReceipt = functions.firestore
    .document("users/{userId}/receipts/{receiptId}")
    .onCreate(async (snap, context) => {
      const {userId} = context.params;
      const userRef = db.doc(`users/${userId}`);

      // Use a transaction to safely increment a counter
      return db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        const newCount = (userDoc.data().receiptCount || 0) + 1;
        transaction.update(userRef, {receiptCount: newCount});

        // Only run the memory update every 5 receipts
        if (newCount % 5 !== 0) {
          return null; // Exit early
        }

        console.log(`Updating memory for user ${userId} at ${newCount} receipts.`);

        // 1. Get the last 15 receipts
        const receiptsQuery = db
            .collection(`users/${userId}/receipts`)
            .orderBy("timestamp", "desc")
            .limit(15);
        const receiptsSnap = await receiptsQuery.get();
        const recentHistory = receiptsSnap.docs
            .map((d) => `- ${d.data().message}`)
            .reverse()
            .join("\n");

        // 2. Get the current memory summary
        const memoryRef = db.doc(`users/${userId}/memory/summary`);
        const memoryDoc = await memoryRef.get();
        const currentMemory = memoryDoc.exists() ? memoryDoc.data().summary : "";

        // 3. Construct the memory update prompt
        const prompt = `You are a memory curator. Here is the user's
current memory summary and their newest journal entries.
Integrate the new information into the existing summary, keeping it concise
(under 500 characters) and focused on key facts, themes, and goals.
Output only the updated summary, not conversational text.

CURRENT SUMMARY:
${currentMemory || "No summary yet."}

NEW ENTRIES:
${recentHistory}`;

        // 4. Call Gemini and save the new summary
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const newSummary = response.text();

        return transaction.set(memoryRef, {
          summary: newSummary,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    });

