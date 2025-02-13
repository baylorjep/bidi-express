const OpenAI = require("openai");
const supabase = require("./supabaseClient");

// Initialize OpenAI with API Key
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

        // Step 2: Fetch request details manually for each bid
        let pastBidsWithRequests = [];

        for (const bid of pastBids) {
            const { data: requestDetails, error: requestError } = await supabase
                .from("requests") // Querying the "requests" table
                .select("service_category, service_title, location, service_date, end_date, service_description, additional_comments")
                .eq("id", bid.request_id)
                .maybeSingle(); // ✅ Prevents errors if no record is found

            if (requestError) {
                console.warn(`⚠️ Error fetching request for request_id ${bid.request_id}:`, requestError.message);
            }

            pastBidsWithRequests.push({
                ...bid,
                requestDetails: requestDetails || { // ✅ Provide default values if request is missing
                    service_category: "Unknown",
                    service_title: "Unknown Service",
                    location: "Unknown",
                    service_date: "Unknown",
                    end_date: "Unknown",
                    service_description: "No details provided",
                    additional_comments: "No details provided"
                },
            });
        }

        // Step 3: Retrieve the business's pricing rules
        const { data: pricingRules, error: pricingError } = await supabase
            .from("business_pricing_rules")
            .select("*")
            .eq("business_id", businessId)
            .single();

        if (pricingError) {
            console.warn("⚠️ No explicit pricing rules found for Business ID:", businessId);
        }

        // Extract pricing details safely
        const pricingDetails = pricingRules
            ? `
            **Pricing Strategy:**  
            - **Min Price:** $${pricingRules?.min_price ?? "N/A"}  
            - **Max Price:** $${pricingRules?.max_price ?? "N/A"}  
            - **Pricing Model:** ${pricingRules?.pricing_model ?? "Not specified"}  
            - **Hourly Rate (if applicable):** $${pricingRules?.hourly_rate ?? "N/A"}  
            - **Default Message template (if applicable):** $${pricingRules?.default_message ?? "N/A"} 
            - **Additional Comments:** ${pricingRules?.additional_comments ?? "None"}  
            `
            : "This business has not set explicit pricing rules. Use past bids and industry norms to guide the bid.";

        // Step 4: Construct AI Prompt (✅ Fixed `bid.requestDetails`)
        const bidHistoryText = pastBidsWithRequests.length > 0
            ? pastBidsWithRequests.map((bid, index) => {
                const request = bid.requestDetails; // ✅ Fetch associated request details

                return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
                for request:
                - **Service:** ${request.service_title || "Unknown"}
                - **Category:** ${request.service_category || "Unknown"}
                - **Location:** ${request.location || "Unknown"}
                - **Date Range:** ${request.service_date || "Unknown"} - ${request.end_date || "Unknown"}
                - **Details:** ${request.service_description || "No details provided"}
                - **Additional Comments:** ${request.additional_comments || "No details provided"}`;
            }).join("\n\n")
            : "No bid history available yet.";

        const prompt = `
            You are an AI-powered business assistant and bidding strategist generating competitive bids for a business.

            ### **Business Profile**
            - **ID:** ${businessId}  
            - **Past Successful Bids and Job Details:**  
            ${bidHistoryText}  
            - **Pricing Strategy & Preferences:**  
            ${pricingDetails}  

            ### **New Service Request**  
            - **Service:** ${requestDetails.service_title}  
            - **Category:** ${requestDetails.service_category}  
            - **Location:** ${requestDetails.location}  
            - **Date Range:** ${requestDetails.service_date} - ${requestDetails.end_date}  
            - **Details:** ${requestDetails.service_description}  
            - **Additional Comments:** ${requestDetails.additional_comments}

            ### **⚡ Weighted Bidding Strategy**
            1. **Start with the pricing rules first**:
            - Base price: ${pricingRules.min_price}  
            - Max price cap: ${pricingRules.max_price}  
            - Per-person, per-hour, or flat-rate: ${pricingRules.pricing_model}  
            - Rush fees, discounts, or special conditions: ${pricingRules.additional_comments}

            2. **Adjust bid using past successful bids:**
            - Look at similar past jobs.
            - Identify **what factors** caused past bids to be higher/lower.
            - Modify bid accordingly **while staying within pricing constraints**.

            3. **Final sanity check:**
            - Ensure bid **isn't below min price** or **above max price**.
            - Format bid description using **business's preferred message template**:
                - Default template: "${pricingRules.default_message_template}"

            4.  **Return JSON format ONLY:**  
            \`\`\`json
            {
                "bidAmount": <calculated bid price>,
                "bidDescription": "<concise bid message>"
            }
            \`\`\`
        `;

        // Step 5: Use OpenAI to Generate the Bid
        console.log("📜 **AI Prompt Sent to OpenAI:**");
        console.log(prompt); // ✅ This prints the full prompt for debugging
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini", // ✅ Uses stable working model
            messages: [{ role: "system", content: prompt }],
            temperature: 0.3,
        });

        const aiBidRaw = completion.choices[0].message.content;

        // **Step 5.5: Clean JSON response before parsing**
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

        // Step 6: Determine Bid Category
        const bidCategory = ["photography", "videography"].includes(requestDetails.service_category.toLowerCase()) 
            ? "Photography" 
            : "General";

        // **Step 7: Insert AI-generated bid into Supabase**
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