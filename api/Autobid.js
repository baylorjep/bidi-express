const OpenAI = require("openai");
const supabase = require("./supabaseClient");

// Initialize OpenAI with API Key
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const generateAutoBidForBusiness = async (businessId, requestDetails) => {
    try {
        console.log(`🔍 Fetching past bids & request details for Business ID: ${businessId}`);

        // Step 1: Retrieve past bids/requests for this business
        const { data: pastBids, error: bidError } = await supabase
            .from("bids")
            .select(`
                bid_amount,
                bid_description,
                request_id,
                requests:request_id(service_category, service_title, location, service_date, end_date, service_description)
            `)
            .eq("user_id", businessId)
            .order("created_at", { ascending: false })
            .limit(10);

        if (bidError) {
            console.error("❌ Error fetching past bids:", bidError.message);
            return null;
        }

        // Step 2: Retrieve the business's pricing rules
        const { data: pricingRules, error: pricingError } = await supabase
            .from("business_pricing_rules")
            .select("*")
            .eq("business_id", businessId)
            .single();

        if (pricingError) {
            console.error("⚠️ No explicit pricing rules found for Business ID:", businessId);
        }

        // Extract pricing details
        const pricingDetails = pricingRules
            ? `
            **Pricing Strategy:**  
            - **Min Price:** $${pricingRules.min_price}  
            - **Max Price:** $${pricingRules.max_price}  
            - **Pricing Model:** ${pricingRules.pricing_model}  
            - **Hourly Rate (if applicable):** $${pricingRules.hourly_rate || "N/A"}  
            - **Additional Comments:** ${pricingRules.additional_comments || "None"}  
            `
            : "This business has not set explicit pricing rules. Use past bids and industry norms to guide the bid.";

      

        // Step 3: Construct AI Prompt

        // grab data from past bids and requests
        const bidHistoryText = pastBids.length > 0
            ? pastBids.map((bid, index) => {
                const request = bid.requests; // Fetch associated request details
                return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
                for request:
                - **Service:** ${request.service_title}
                - **Category:** ${request.service_category}
                - **Location:** ${request.location}
                - **Date Range:** ${request.service_date} - ${request.end_date}
                - **Details:** ${request.service_description}`;
            }).join("\n\n")
            : "No bid history available yet.";


        const prompt = `
            You are an AI-powered business assistant and bidding strategist generating competitive bids for a business.

            ### **Business Profile:
            ID:** ${businessId}  
            ** Your past successful bids and their job details: 
            ${bidHistoryText} **
            ** Pricing Strategy and preferences: ${pricingDetails} **

            **New Service Request:**  
            - **Service:** ${requestDetails.service_title}  
            - **Category:** ${requestDetails.service_category}  
            - **Location:** ${requestDetails.location}  
            - **Date Range:** ${requestDetails.service_date} - ${requestDetails.end_date}  
            - **Details:** ${requestDetails.service_description}  

            ### **⚡ Bidding Strategy**
            1. Base bid on **past similar jobs** when available.
            2. Ensure bid follows **business’s pricing strategy and preferences**.
            3. If no past bids or pricing preferences exist, estimate a **fair market bid**, and mention in the description that the price is subject to change.
            4. Adjust price if **urgent or complex**.
            5. Return **only JSON**, with no extra text.  

            **Return JSON format ONLY:**  
            \`\`\`json
            {
                "bidAmount": <calculated bid price>,
                "bidDescription": "<concise bid message>"
            }
            \`\`\`
        `;

        // Step 4: Use OpenAI to Generate the Bid
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini", // ✅ Uses stable working model
            messages: [{ role: "system", content: prompt }],
            temperature: 0.3,
        });

        const aiBidRaw = completion.choices[0].message.content;

        // **Step 4.5: Clean JSON response before parsing**
        const match = aiBidRaw.match(/```json\n([\s\S]*?)\n```/);
        let aiBidClean = match ? match[1].trim() : aiBidRaw.trim();

        let aiBid;
        try {
            aiBid = JSON.parse(aiBidClean);
            console.log(`✅ AI-Generated Bid for Business ${businessId}:`, aiBid);
        } catch (error) {
            console.error("❌ Error parsing AI bid response:", aiBidClean, error);
            return null;
        }

        // Step 5: Determine Bid Category
        const bidCategory = ["photography", "videography"].includes(requestDetails.service_category.toLowerCase()) 
            ? "Photography" 
            : "General";

        // **Step 6: Insert AI-generated bid into Supabase**
        const { error: insertError } = await supabase
            .from("bids")
            .insert([
                {
                    request_id: requestDetails.id,
                    user_id: businessId,
                    bid_amount: aiBid.bidAmount,
                    bid_description: aiBid.bidDescription,
                    category: bidCategory, // Auto-set category based on request
                    status: "pending", // ✅ Ensures default "pending" status
                    hidden: null // ✅ Matches your DB defaults
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