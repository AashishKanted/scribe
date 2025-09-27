const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {GoogleAuth} = require("google-auth-library");
const {DiscussServiceClient} = require("@google-ai/generativelanguage");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Initialize Google AI Client
const MODEL_NAME = "models/gemini-2.5-flash-preview-05-20";
// Securely access the API key
const API_KEY = functions.config().gemini.key;

const client = new DiscussServiceClient({
  authClient: new GoogleAuth().fromAPIKey(API_KEY),
});

exports.getEnhancedReceipt = functions.https.onCall(async (data, context) => {
  // Ensure the user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be logged in to use the AI Scribe.",
    );
  }

  const rawText = data.text;
  const uid = context.auth.token.uid;

  if (!rawText) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "The function must be called with one argument 'text' " +
        "containing the message to rewrite.",
    );
  }

  try {
    // 1. Fetch recent receipts for context
    const receiptsRef = db
        .collection(`users/${uid}/receipts`)
        .orderBy("timestamp", "desc")
        .limit(3);
    const snapshot = await receiptsRef.get();
    const recentReceipts = [];
    snapshot.forEach((doc) => {
      recentReceipts.push(doc.data());
    });

    // Reverse to get chronological order
    const contextText = recentReceipts
        .reverse()
        .map((r) => `- ${r.message}`)
        .join("\n");

    // 2. Construct the prompt
    const prompt = [
      "You are a supportive and insightful biographer.",
      "Your task is to take a raw note from a user and expand it into a",
      "beautifully written, reflective journal entry of 2-3 sentences.",
      "Frame it as a significant moment in their life story.",
      "",
      "Use the following recent entries as context to understand recurring",
      "themes or ongoing stories. This context should inform the tone and",
      "perspective of your writing, but do not explicitly reference these",
      "past entries.",
      "CONTEXT of the last few entries:",
      contextText || "No recent entries.",
      "",
      "Now, based on that context, please rephrase the following NEW NOTE:",
      `NEW NOTE: "${rawText}"`,
    ].join("\n");

    // 3. Call the Gemini API
    const result = await client.generateMessage({
      model: MODEL_NAME,
      prompt: {
        messages: [{content: prompt}],
      },
    });

    // 4. Return the result
    const enhancedText = result[0].candidates[0].content;
    return {text: enhancedText};
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw new functions.https.HttpsError(
        "internal",
        "Failed to get a response from the AI Scribe.",
    );
  }
});
