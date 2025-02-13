const OpenAI = require("openai");
const supabase = require("./supabaseClient");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const generateAutoBidForBusiness = async (businessId, requestDetails) => {
    try {
        console.log(`🔍 Fetching past bids & request details for Business ID: ${businessId}`);

        const prompt = `
            You are an AI-powered bidding strategist generating competitive bids for a business.

            **Business ID:** ${businessId}  
            **New Service Request:**  
            - **Service:** ${requestDetails.title}  
            - **Category:** ${requestDetails.category}  
            - **Location:** ${requestDetails.location}  
            - **Date Range:** ${requestDetails.start_date} - ${requestDetails.end_date}  
            - **Details:** ${requestDetails.details}  

            **Generate a JSON response:**  
            {
                "bidAmount": <calculated price>,
                "bidDescription": "<concise bid message>"
            }
        `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: prompt }],
            temperature: 0.3,
        });

        const aiBid = JSON.parse(completion.choices[0].message.content);
        console.log(`✅ AI-Generated Bid:`, aiBid);

        return aiBid;
    } catch (error) {
        console.error("❌ Error generating AI bid:", error);
        return null;
    }
};

// Export function
module.exports = { generateAutoBidForBusiness };