const OpenAI = require("openai");
const supabase = require("./supabaseClient");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const generateAutoBidForBusiness = async (businessId, requestDetails) => {
    try {
        console.log(`🔍 Fetching past bids & request details for Business ID: ${businessId}`);

        const { data: pastBids, error: bidError } = await supabase
            .from("bids")
            .select("bid_amount, bid_description, request_id")
            .eq("user_id", businessId) // Assuming user_id is the business ID
            .order("created_at", { ascending: false })
            .limit(10);

        if (bidError) {
            console.error("❌ Error fetching past bids:", bidError); // Log the error object
            return null;
        }

        const bidHistoryText = pastBids && pastBids.length > 0  // Check if pastBids exists
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

            **Return JSON format ONLY:**  
            \`\`\`json
            {
                "bidAmount": <calculated bid price>,
                "bidDescription": "<concise bid message>"
            }
            \`\`\`
        `;

        const completion = await openai.chat.completions.create({
            model: "o1-mini", // Or another suitable model
            messages: [{ role: "user", content: prompt }],
        });

        const aiBidRaw = completion.choices[0].message.content;

        // Extract JSON using a more robust approach
        const match = aiBidRaw.match(/```json\n([\s\S]*?)\n```/);
        let aiBidClean;
        if (match) {
            aiBidClean = match[1].trim();
        } else {
            console.error("❌ No JSON block found in AI response:", aiBidRaw);
            return null;
        }

        let aiBid;
        try {
            aiBid = JSON.parse(aiBidClean);
            console.log(`✅ AI-Generated Bid for Business ${businessId}:`, aiBid);
        } catch (error) {
            console.error("❌ Error parsing AI bid response:", aiBidClean, error);
            return null;
        }

        const bidCategory = ["photography", "videography"].includes(requestDetails.service_category?.toLowerCase()) // Optional chaining
            ? "Photography"
            : "General";

        const { error: insertError } = await supabase
            .from("bids")
            .insert([
                {
                    request_id: requestDetails.id,
                    user_id: businessId,
                    bid_amount: aiBid.bidAmount,
                    bid_description: aiBid.bidDescription,
                    category: bidCategory,
                },
            ]);

        if (insertError) {
            console.error("❌ Error inserting AI bid into database:", insertError); // Log the error object
            return null;
        }

        console.log(`🚀 AI bid successfully inserted into database for Business ${businessId}`);
        return aiBid;

    } catch (error) {
        console.error("❌ Error generating AI bid:", error); // Log the error object
        return null;
    }
};


app.post('/trigger-autobid', async (req, res) => {
    // ... (rest of your route code)

    try {
        // ... (fetch request details and businesses)

        const autoBidPromises = autoBidBusinesses.map(async (business) => { // Use map for parallel execution
            return generateAutoBidForBusiness(business.id, requestDetails);
        });

        const bids = await Promise.all(autoBidPromises); // Wait for all bids to be generated

        const successfulBids = bids.filter(bid => bid !== null); // Filter out failed bid generations

        res.status(200).json({
            message: "Auto-bids generated successfully (LOG ONLY, NO INSERTION)",
            bids: successfulBids, // Return only successful bids
        });

    } catch (error) {
       // ... (error handling)
    }
});

module.exports = { generateAutoBidForBusiness };