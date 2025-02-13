const OpenAI = require("openai");
const supabase = require("./supabaseClient");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const generateAutoBidForBusiness = async (businessId, requestDetails) => {
    try {
        console.log(`🔍 Fetching past bids & request details for Business ID: ${businessId}`);

        // Step 1: Retrieve past bids for this business
        const { data: pastBids, error: bidError } = await supabase
            .from("bids")
            .select("bid_amount, bid_description, request_id")
            .eq("user_id", businessId)
            .order("created_at", { ascending: false })
            .limit(10);

        if (bidError) {
            console.error("❌ Error fetching past bids:", bidError.message);
            return null;
        }

        // Step 2: Construct AI Prompt
        const bidHistoryText = pastBids.length > 0
            ? pastBids.map((bid, index) => 
                `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" on Request ${bid.request_id}`
              ).join("\n")
            : "No bid history available yet.";

        const prompt = `
            You are an AI-powered bidding strategist generating competitive bids for a business.

            **Business ID:** ${businessId}  
            **Past Bids & Performance:**  
            ${bidHistoryText}

            **New Service Request:**  
            - **Service:** ${requestDetails.service_title}  
            - **Category:** ${requestDetails.service_category}  
            - **Location:** ${requestDetails.location}  
            - **Date Range:** ${requestDetails.service_date} - ${requestDetails.end_date}  
            - **Details:** ${requestDetails.service_description}  

            **Bid Strategy:**  
            - Generate a bid based on past successful bids if available.  
            - If no past bids exist, estimate a fair market bid.  
            - Make the bid **competitive but reasonable**.  

            **Return JSON format:**  
            {
                "bidAmount": <calculated bid price>,
                "bidDescription": "<concise bid message>"
            }
        `;

        // Step 3: Use OpenAI to Generate the Bid
        const completion = await openai.chat.completions.create({
            model: "o1-mini",
            messages: [{ role: "user", content: prompt }],
            
        });

        const aiBid = JSON.parse(completion.choices[0].message.content);
        console.log(`✅ AI-Generated Bid for Business ${businessId}:`, aiBid);

        // Step 4: Determine Bid Category
        const bidCategory = ["photography", "videography"].includes(requestDetails.service_category.toLowerCase()) 
            ? "Photography" 
            : "General";

        // Step 5: Insert AI-generated bid into Supabase
        const { error: insertError } = await supabase
            .from("bids")
            .insert([
                {
                    request_id: requestDetails.id,
                    user_id: businessId,
                    bid_amount: aiBid.bidAmount,
                    bid_description: aiBid.bidDescription,
                    category: bidCategory, // Auto-set category based on request
                },
            ]);

        if (insertError) {
            console.error("❌ Error inserting AI bid into database:", insertError.message);
            return null;
        }

        console.log(`🚀 AI bid successfully inserted into database for Business ${businessId}`);
        return aiBid;

    } catch (error) {
        console.error("❌ Error generating AI bid:", error);
        return null;
    }
};

// Export function
module.exports = { generateAutoBidForBusiness };