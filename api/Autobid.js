const openai = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = require("./supabaseClient"); 

const generateAutoBidForBusiness = async (businessId, requestDetails) => {
    try {
        console.log(`🔍 Fetching past bids & request details for Business ID: ${businessId}`);

        // Step 1: Retrieve past bids for this business
        const { data: pastBids, error: bidError } = await supabase
            .from("bids")
            .select("bid_amount, bid_description, request_id, won_bid")
            .eq("user_id", businessId)
            .order("created_at", { ascending: false })
            .limit(10);

        if (bidError) {
            console.error("❌ Error fetching past bids:", bidError.message);
            return null;
        }

        // Step 2: Fetch request details for past bids
        let pastRequestDetails = [];
        if (pastBids.length > 0) {
            const requestIds = pastBids.map(bid => bid.request_id);
            const { data: requests, error: requestError } = await supabase
                .from("requests")
                .select("id, category, title, location, start_date, end_date, details")
                .in("id", requestIds);

            if (!requestError) {
                pastRequestDetails = requests;
            }
        }

        // Step 3: Format past bid history + request details
        const bidHistoryText = pastBids.length > 0
            ? pastBids.map((bid, index) => {
                const request = pastRequestDetails.find(r => r.id === bid.request_id);
                return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" on "${request?.title}" (Category: ${request?.category}, Location: ${request?.location}) - Won: ${bid.won_bid ? "Yes" : "No"}`;
              }).join("\n")
            : "No bid history available yet.";

        // Step 4: Construct AI Prompt for Bidding
        const prompt = `
            You are an AI-powered bidding strategist generating competitive bids for a business.

            **Business ID:** ${businessId}  
            **Past Bids & Performance:**  
            ${bidHistoryText}

            **New Service Request:**  
            - **Service:** ${requestDetails.title}  
            - **Category:** ${requestDetails.category}  
            - **Location:** ${requestDetails.location}  
            - **Date Range:** ${requestDetails.start_date} - ${requestDetails.end_date}  
            - **Details:** ${requestDetails.details}  

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

        // Step 5: Use OpenAI API to generate a structured bid
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: prompt }],
            temperature: 0.3,
        });

        const aiBid = JSON.parse(completion.choices[0].message.content);
        console.log(`✅ AI-Generated Bid for Business ${businessId}:`, aiBid);

        return aiBid;

    } catch (error) {
        console.error("❌ Error generating AI bid:", error);
        return null;
    }
};

// Export function
module.exports = { generateAutoBidForBusiness };