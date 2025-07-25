const OpenAI = require("openai");
const supabase = require("./supabaseClient");

// Initialize OpenAI with API Key
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper function to determine the correct table name based on category
const getTableNameForCategory = (category) => {
    const categoryMap = {
        'catering': 'catering_requests',
        'dj': 'dj_requests',
        'beauty': 'beauty_requests',
        'florist': 'florist_requests',
        'wedding_planning': 'wedding_planning_requests',
        'videography': 'videography_requests',
        'photography': 'photography_requests'
    };
    
    const normalizedCategory = category.toLowerCase().replace(/\s+/g, '_');
    return categoryMap[normalizedCategory] || null;
};

// Category-specific bidding strategies
const getCategorySpecificPrompt = (category, requestData, pricingRules, bidHistory) => {
    const basePrompt = `
        You are an AI-powered business assistant and bidding strategist generating competitive bids for a business.

        ### **Business Profile**
        - **ID:** ${requestData.businessId}  
        - **Pricing Strategy:**  
        - **Min Price:** $${pricingRules?.min_price ?? "N/A"}  
        - **Max Price:** $${pricingRules?.max_price ?? "N/A"}  
        - **Pricing Model:** ${pricingRules?.pricing_model ?? "Not specified"}  
        - **Hourly Rate:** $${pricingRules?.hourly_rate ?? "N/A"}  
        - **Default Message:** ${pricingRules?.default_message ?? "N/A"} 
        - **Additional Comments:** ${pricingRules?.additional_comments ?? "None"}  

        ### **Past Bid History:**  
        ${bidHistory}

        ### **New Service Request**  
        ${requestData.formattedRequest}

        ### **Category-Specific Bidding Strategy**
        ${requestData.categoryStrategy}

        ### **Return JSON format ONLY:**  
        \`\`\`json
        {
            "bidAmount": <calculated bid price>,
            "bidDescription": "<concise bid message>"
        }
        \`\`\`
    `;

    return basePrompt;
};

// Category-specific request formatters and strategies
const categoryHandlers = {
    catering: {
        formatRequest: (data) => ({
            businessId: data.businessId,
            formattedRequest: `
                - **Service:** ${data.title || 'Catering Service'}
                - **Category:** Catering
                - **Event Type:** ${data.event_type || 'Unknown'}
                - **Location:** ${data.location || 'Unknown'}
                - **Date:** ${data.start_date || 'Unknown'}
                - **Guest Count:** ${data.estimated_guests || 'Unknown'}
                - **Food Preferences:** ${JSON.stringify(data.food_preferences || {})}
                - **Budget Range:** ${data.budget_range || 'Not specified'}
                - **Equipment Needs:** ${data.equipment_needed || 'Not specified'}
                - **Setup/Cleanup:** ${data.setup_cleanup || 'Not specified'}
                - **Food Service Type:** ${data.food_service_type || 'Not specified'}
                - **Serving Staff:** ${data.serving_staff || 'Not specified'}
                - **Dietary Restrictions:** ${JSON.stringify(data.dietary_restrictions || [])}
                - **Additional Comments:** ${data.additional_comments || 'None'}
            `,
            categoryStrategy: `
                **CATERING-SPECIFIC PRICING FACTORS:**
                1. **Per-Person Pricing:** Base cost per guest (typically $15-50+ per person)
                2. **Guest Count Impact:** Higher guest counts often reduce per-person cost due to economies of scale
                3. **Food Complexity:** Premium cuisines (French, Italian) cost more than basic options
                4. **Service Level:** Full-service (staff, setup, cleanup) vs. delivery-only
                5. **Equipment Needs:** Venue equipment vs. bringing everything
                6. **Dietary Restrictions:** Special dietary needs may increase costs
                7. **Event Type:** Weddings typically command premium pricing
                8. **Location:** Travel distance and venue accessibility
                9. **Setup/Cleanup:** Additional labor costs for full service
                10. **Serving Staff:** Number of servers needed based on guest count

                **BIDDING APPROACH:**
                - Start with base per-person cost × guest count
                - Add service fees for setup/cleanup if required
                - Adjust for food complexity and dietary restrictions
                - Consider equipment rental if venue doesn't provide
                - Factor in travel distance and event type premium
                - Stay within business pricing constraints
            `
        }),
        formatBidHistory: (bids) => bids.map((bid, index) => {
            const request = bid.requestDetails;
            return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
            for ${request.event_type || 'Unknown'} event with ${request.estimated_guests || 'Unknown'} guests in ${request.location || 'Unknown'}`;
        }).join("\n\n")
    },

    dj: {
        formatRequest: (data) => ({
            businessId: data.businessId,
            formattedRequest: `
                - **Service:** ${data.title || 'DJ Service'}
                - **Category:** DJ
                - **Event Type:** ${data.event_type || 'Unknown'}
                - **Location:** ${data.location || 'Unknown'}
                - **Date:** ${data.start_date || 'Unknown'}
                - **Duration:** ${data.event_duration || 'Unknown'} hours
                - **Guest Count:** ${data.estimated_guests || 'Unknown'}
                - **Music Preferences:** ${JSON.stringify(data.music_preferences || {})}
                - **Budget Range:** ${data.budget_range || 'Not specified'}
                - **Equipment Needs:** ${data.equipment_needed || 'Not specified'}
                - **Additional Services:** ${JSON.stringify(data.additional_services || {})}
                - **Special Requests:** ${data.special_requests || 'None'}
            `,
            categoryStrategy: `
                **DJ-SPECIFIC PRICING FACTORS:**
                1. **Hourly Rate:** Base rate per hour (typically $100-300+ per hour)
                2. **Event Duration:** Longer events may have discounted hourly rates
                3. **Event Type:** Weddings command premium pricing vs. corporate events
                4. **Equipment Needs:** Bringing full setup vs. venue equipment
                5. **Additional Services:** MC services, lighting, photo booth add-ons
                6. **Music Complexity:** Multiple genres, special requests, custom playlists
                7. **Guest Count:** Larger crowds may require more equipment/power
                8. **Location:** Travel distance and venue accessibility
                9. **Setup/Teardown Time:** Additional hours for equipment setup
                10. **Experience Level:** Premium DJs command higher rates

                **BIDDING APPROACH:**
                - Start with base hourly rate × event duration
                - Add setup/teardown time if needed
                - Include additional services (MC, lighting, etc.)
                - Adjust for event type premium (weddings)
                - Factor in equipment needs and travel distance
                - Consider music complexity and special requests
                - Stay within business pricing constraints
            `
        }),
        formatBidHistory: (bids) => bids.map((bid, index) => {
            const request = bid.requestDetails;
            return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
            for ${request.event_type || 'Unknown'} event lasting ${request.event_duration || 'Unknown'} hours in ${request.location || 'Unknown'}`;
        }).join("\n\n")
    },

    beauty: {
        formatRequest: (data) => ({
            businessId: data.businessId,
            formattedRequest: `
                - **Service:** ${data.event_title || 'Beauty Service'}
                - **Category:** Beauty
                - **Event Type:** ${data.event_type || 'Unknown'}
                - **Location:** ${data.location || 'Unknown'}
                - **Date:** ${data.start_date || 'Unknown'}
                - **Service Type:** ${data.service_type || 'Unknown'}
                - **Number of People:** ${data.num_people || 'Unknown'}
                - **Price Range:** ${data.price_range || 'Not specified'}
                - **Hairstyle Preferences:** ${data.hairstyle_preferences || 'Not specified'}
                - **Makeup Style:** ${data.makeup_style_preferences || 'Not specified'}
                - **Trial Sessions:** Hair: ${data.trial_session_hair || 'No'}, Makeup: ${data.trial_session_makeup || 'No'}
                - **On-Site Service:** ${data.on_site_service_needed || 'No'}
                - **Additional Comments:** ${data.additional_comments || 'None'}
            `,
            categoryStrategy: `
                **BEAUTY-SPECIFIC PRICING FACTORS:**
                1. **Per-Person Rate:** Base cost per person (typically $100-300+ per person)
                2. **Service Type:** Hair only, makeup only, or both services
                3. **Event Type:** Weddings command premium pricing
                4. **Trial Sessions:** Additional cost for hair/makeup trials
                5. **On-Site Service:** Travel fee for venue services
                6. **Complexity:** Intricate hairstyles or elaborate makeup
                7. **Group Discounts:** Multiple people may qualify for discounts
                8. **Experience Level:** Premium stylists command higher rates
                9. **Products Used:** Premium products may increase costs
                10. **Time Requirements:** Complex styles require more time

                **BIDDING APPROACH:**
                - Start with base per-person rate × number of people
                - Add service type multiplier (hair + makeup = higher rate)
                - Include trial session costs if requested
                - Add travel fee for on-site service
                - Apply group discount for multiple people
                - Factor in complexity and time requirements
                - Consider event type premium (weddings)
                - Stay within business pricing constraints
            `
        }),
        formatBidHistory: (bids) => bids.map((bid, index) => {
            const request = bid.requestDetails;
            return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
            for ${request.service_type || 'Unknown'} service for ${request.num_people || 'Unknown'} people in ${request.location || 'Unknown'}`;
        }).join("\n\n")
    },

    florist: {
        formatRequest: (data) => ({
            businessId: data.businessId,
            formattedRequest: `
                - **Service:** ${data.event_title || 'Florist Service'}
                - **Category:** Florist
                - **Event Type:** ${data.event_type || 'Unknown'}
                - **Location:** ${data.location || 'Unknown'}
                - **Date:** ${data.start_date || 'Unknown'}
                - **Price Range:** ${data.price_range || 'Not specified'}
                - **Flower Preferences:** ${JSON.stringify(data.flower_preferences || {})}
                - **Floral Arrangements:** ${JSON.stringify(data.floral_arrangements || {})}
                - **Additional Services:** ${JSON.stringify(data.additional_services || {})}
                - **Colors:** ${JSON.stringify(data.colors || [])}
                - **Additional Comments:** ${data.additional_comments || 'None'}
            `,
            categoryStrategy: `
                **FLORIST-SPECIFIC PRICING FACTORS:**
                1. **Arrangement Types:** Bouquets, boutonnieres, centerpieces, arches
                2. **Flower Types:** Premium flowers (peonies, roses) vs. seasonal blooms
                3. **Quantity:** Number of each arrangement type
                4. **Seasonality:** Off-season flowers cost more
                5. **Complexity:** Intricate designs vs. simple arrangements
                6. **Additional Services:** Setup, delivery, consultation
                7. **Event Type:** Weddings command premium pricing
                8. **Location:** Delivery distance and setup requirements
                9. **Color Requirements:** Specific color matching may increase costs
                10. **Timeline:** Rush orders may incur additional fees

                **BIDDING APPROACH:**
                - Calculate cost per arrangement type × quantity
                - Factor in flower type costs (premium vs. seasonal)
                - Add setup and delivery fees if required
                - Consider complexity and design requirements
                - Apply event type premium (weddings)
                - Factor in seasonality and color requirements
                - Include consultation fee if needed
                - Stay within business pricing constraints
            `
        }),
        formatBidHistory: (bids) => bids.map((bid, index) => {
            const request = bid.requestDetails;
            return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
            for ${request.event_type || 'Unknown'} with ${JSON.stringify(request.floral_arrangements || {})} in ${request.location || 'Unknown'}`;
        }).join("\n\n")
    },

    wedding_planning: {
        formatRequest: (data) => ({
            businessId: data.businessId,
            formattedRequest: `
                - **Service:** ${data.event_title || 'Wedding Planning Service'}
                - **Category:** Wedding Planning
                - **Event Type:** ${data.event_type || 'Unknown'}
                - **Location:** ${data.location || 'Unknown'}
                - **Date:** ${data.start_date || 'Unknown'}
                - **Guest Count:** ${data.guest_count || 'Unknown'}
                - **Planning Level:** ${data.planning_level || 'Unknown'}
                - **Experience Level:** ${data.experience_level || 'Unknown'}
                - **Budget Range:** ${data.budget_range || 'Not specified'}
                - **Planner Budget:** ${data.planner_budget || 'Not specified'}
                - **Communication Style:** ${data.communication_style || 'Not specified'}
                - **Additional Comments:** ${data.additional_comments || 'None'}
            `,
            categoryStrategy: `
                **WEDDING PLANNING-SPECIFIC PRICING FACTORS:**
                1. **Planning Level:** Full planning, partial planning, day-of coordination
                2. **Guest Count:** Larger weddings require more coordination
                3. **Experience Level:** Beginner couples need more guidance
                4. **Timeline:** Months of planning vs. day-of only
                5. **Vendor Management:** Number of vendors to coordinate
                6. **Event Complexity:** Multiple events, destination weddings
                7. **Communication Needs:** Frequency of meetings and updates
                8. **Budget Size:** Higher budgets may command higher planner fees
                9. **Location:** Travel requirements and venue complexity
                10. **Additional Services:** Rehearsal dinner, welcome party coordination

                **BIDDING APPROACH:**
                - Base rate for planning level (full/partial/day-of)
                - Adjust for guest count complexity
                - Factor in experience level requirements
                - Consider timeline and communication needs
                - Add vendor management fees
                - Include travel costs if needed
                - Apply budget-based percentage for high-end weddings
                - Stay within business pricing constraints
            `
        }),
        formatBidHistory: (bids) => bids.map((bid, index) => {
            const request = bid.requestDetails;
            return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
            for ${request.planning_level || 'Unknown'} planning for ${request.guest_count || 'Unknown'} guests in ${request.location || 'Unknown'}`;
        }).join("\n\n")
    },

    videography: {
        formatRequest: (data) => ({
            businessId: data.businessId,
            formattedRequest: `
                - **Service:** ${data.event_title || 'Videography Service'}
                - **Category:** Videography
                - **Event Type:** ${data.event_type || 'Unknown'}
                - **Location:** ${data.location || 'Unknown'}
                - **Date:** ${data.start_date || 'Unknown'}
                - **Duration:** ${data.duration || 'Unknown'} hours
                - **Number of People:** ${data.num_people || 'Unknown'}
                - **Style Preferences:** ${JSON.stringify(data.style_preferences || {})}
                - **Deliverables:** ${JSON.stringify(data.deliverables || {})}
                - **Coverage:** ${JSON.stringify(data.coverage || {})}
                - **Price Range:** ${data.price_range || 'Not specified'}
                - **Additional Comments:** ${data.additional_comments || 'None'}
            `,
            categoryStrategy: `
                **VIDEOGRAPHY-SPECIFIC PRICING FACTORS:**
                1. **Hourly Rate:** Base rate per hour of coverage (typically $150-500+ per hour)
                2. **Coverage Type:** Ceremony only, reception only, full day
                3. **Event Duration:** Longer events may have discounted hourly rates
                4. **Deliverables:** Raw footage, edited video, highlight reel, full film
                5. **Style Complexity:** Artistic, documentary, traditional styles
                6. **Equipment:** Multiple cameras, drones, lighting
                7. **Post-Production:** Editing time, color grading, music licensing
                8. **Event Type:** Weddings command premium pricing
                9. **Location:** Travel distance and venue accessibility
                10. **Timeline:** Rush delivery may incur additional fees

                **BIDDING APPROACH:**
                - Start with base hourly rate × coverage duration
                - Add equipment rental costs if needed
                - Factor in post-production time and complexity
                - Include deliverable costs (multiple formats)
                - Apply event type premium (weddings)
                - Consider style complexity and artistic requirements
                - Add travel costs for distant locations
                - Include rush fees if tight timeline
                - Stay within business pricing constraints
            `
        }),
        formatBidHistory: (bids) => bids.map((bid, index) => {
            const request = bid.requestDetails;
            return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
            for ${request.event_type || 'Unknown'} lasting ${request.duration || 'Unknown'} hours in ${request.location || 'Unknown'}`;
        }).join("\n\n")
    },

    photography: {
        formatRequest: (data) => ({
            businessId: data.businessId,
            formattedRequest: `
                - **Service:** ${data.event_title || 'Photography Service'}
                - **Category:** Photography
                - **Event Type:** ${data.event_type || 'Unknown'}
                - **Location:** ${data.location || 'Unknown'}
                - **Date:** ${data.start_date || 'Unknown'}
                - **Duration:** ${data.duration || 'Unknown'} hours
                - **Number of People:** ${data.num_people || 'Unknown'}
                - **Style Preferences:** ${JSON.stringify(data.style_preferences || {})}
                - **Deliverables:** ${JSON.stringify(data.deliverables || {})}
                - **Coverage:** ${JSON.stringify(data.coverage || {})}
                - **Price Range:** ${data.price_range || 'Not specified'}
                - **Additional Comments:** ${data.additional_comments || 'None'}
            `,
            categoryStrategy: `
                **PHOTOGRAPHY-SPECIFIC PRICING FACTORS:**
                1. **Hourly Rate:** Base rate per hour of coverage (typically $100-400+ per hour)
                2. **Coverage Type:** Ceremony only, reception only, full day
                3. **Event Duration:** Longer events may have discounted hourly rates
                4. **Deliverables:** Digital files, prints, albums, engagement sessions
                5. **Style Complexity:** Artistic, documentary, traditional styles
                6. **Equipment:** Multiple cameras, lenses, lighting
                7. **Post-Production:** Editing time, retouching, album design
                8. **Event Type:** Weddings command premium pricing
                9. **Location:** Travel distance and venue accessibility
                10. **Second Photographer:** Additional photographer costs

                **BIDDING APPROACH:**
                - Start with base hourly rate × coverage duration
                - Add second photographer if needed
                - Factor in post-production time and complexity
                - Include deliverable costs (albums, prints, etc.)
                - Apply event type premium (weddings)
                - Consider style complexity and artistic requirements
                - Add travel costs for distant locations
                - Include engagement session if included
                - Stay within business pricing constraints
            `
        }),
        formatBidHistory: (bids) => bids.map((bid, index) => {
            const request = bid.requestDetails;
            return `Bid ${index + 1}: $${bid.bid_amount} - "${bid.bid_description}" 
            for ${request.event_type || 'Unknown'} lasting ${request.duration || 'Unknown'} hours in ${request.location || 'Unknown'}`;
        }).join("\n\n")
    }
};

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

        // Step 2: Fetch request details manually for each bid from appropriate tables
        let pastBidsWithRequests = [];

        for (const bid of pastBids) {
            // Try to find the request in each category table
            let requestData = null;
            let foundCategory = null;

            const categories = ['catering', 'dj', 'beauty', 'florist', 'wedding_planning', 'videography', 'photography'];
            
            for (const category of categories) {
                const tableName = getTableNameForCategory(category);
                if (!tableName) continue;

                const { data, error } = await supabase
                    .from(tableName)
                    .select("*")
                .eq("id", bid.request_id)
                .maybeSingle();

                if (!error && data) {
                    requestData = data;
                    foundCategory = category;
                    break;
                }
            }

            if (requestData && foundCategory) {
            pastBidsWithRequests.push({
                ...bid,
                    requestDetails: requestData,
                    category: foundCategory
                });
            }
        }

        // Step 3: Retrieve the business's pricing rules
        const { data: pricingRules, error: pricingError } = await supabase
            .from("business_pricing_rules")
            .select("*")
            .eq("business_id", businessId)
            .eq("category", requestDetails.service_category)
            .single();

        if (pricingError) {
            console.warn("⚠️ No explicit pricing rules found for Business ID:", businessId, "Category:", requestDetails.service_category);
        }

        // Step 3.1: Check dealbreakers before proceeding
        if (pricingRules) {
            const dealbreakerCheck = checkDealbreakers(requestDetails, pricingRules);
            if (!dealbreakerCheck.allowed) {
                console.log(`❌ Request violates dealbreakers: ${dealbreakerCheck.violations.join(', ')}`);
                return null; // Auto-decline
            }
        }

        // Step 3.2: Get business location for travel calculations
        const { data: businessProfile, error: businessError } = await supabase
            .from("businesses")
            .select("location")
            .eq("id", businessId)
            .single();

        if (businessError) {
            console.warn("⚠️ Could not fetch business location for travel calculations");
        }

        // Step 3.3: Calculate travel fees
        let travelFees = { fee: 0, warning: null };
        if (pricingRules?.travel_config && businessProfile?.location && requestDetails.location) {
            travelFees = calculateTravelFees(
                businessProfile.location,
                requestDetails.location,
                pricingRules.travel_config
            );
            console.log(`🚗 Travel fees calculated: $${travelFees.fee}, Warning: ${travelFees.warning}`);
        }

        // Step 3.4: Calculate base price using simplified pricing logic
        let basePrice = 0;
        if (pricingRules) {
            // Use explicit pricing rules as the foundation
            basePrice = calculateCategoryPricing(requestDetails, pricingRules);
            
            // Apply platform markup if specified
            let finalPrice = basePrice;
            if (pricingRules.platform_fee_markup_percent) {
                const markup = finalPrice * (parseFloat(pricingRules.platform_fee_markup_percent) / 100);
                finalPrice += markup;
            }
            
            console.log(`💰 Base pricing calculated: $${basePrice} -> Final $${finalPrice}`);
        } else {
            // Fallback to training data average if no pricing rules
            const avgBid = pastBids.length > 0 ? 
                pastBids.reduce((sum, bid) => sum + bid.bid_amount, 0) / pastBids.length : 1000;
            basePrice = Math.round(avgBid * 0.9); // Use 90% of average as base
            console.log(`⚠️ No pricing rules found, using bid average: $${avgBid} -> Base $${basePrice}`);
        }

        // Step 3.5: Apply platform markup
        let finalPrice = basePrice + travelFees.fee;
        if (pricingRules?.platform_fee_markup_percent) {
            const markup = finalPrice * (parseFloat(pricingRules.platform_fee_markup_percent) / 100);
            finalPrice += markup;
            console.log(`📈 Applied platform markup: +$${markup.toFixed(2)} = $${finalPrice}`);
        }

        // Step 3.6: Retrieve the business's packages
        const { data: businessPackages, error: packagesError } = await supabase
            .from("business_packages")
            .select("*")
            .eq("business_id", businessId)
            .order("display_order", { ascending: true });

        if (packagesError) {
            console.warn("⚠️ No packages found for Business ID:", businessId);
        } else {
            console.log(`📦 Found ${businessPackages?.length || 0} packages for business`);
        }

        // Step 4: Get training data for enhanced AI generation
        console.log("🎓 Fetching training data for enhanced AI generation...");
        const trainingData = await getBusinessTrainingData(businessId, requestDetails.service_category);
        console.log(`📊 Found ${trainingData.responses?.length || 0} training responses and ${trainingData.feedback?.length || 0} feedback entries`);

        // Step 5: Get category-specific handler
        const category = requestDetails.service_category.toLowerCase();
        const handler = categoryHandlers[category];

        if (!handler) {
            console.error(`❌ No handler found for category: ${category}`);
                return null;
        }

        // Step 6: Format request data and bid history using category-specific logic
        const formattedRequestData = handler.formatRequest({
            ...requestDetails,
            businessId
        });

        const formattedBidHistory = handler.formatBidHistory(pastBidsWithRequests);

        // Step 7: Generate enhanced AI prompt with training data
        const prompt = getEnhancedCategorySpecificPrompt(
            category,
            formattedRequestData,
            pricingRules,
            formattedBidHistory,
            trainingData,
            businessPackages,
            {
                basePrice,
                travelFees,
                finalPrice,
                dealbreakerCheck: pricingRules ? checkDealbreakers(requestDetails, pricingRules) : { allowed: true, violations: [] }
            }
        );

        // Step 8: Use OpenAI to Generate the Bid
        console.log(`📜 **Enhanced AI Prompt Sent to OpenAI for ${category} category:**`);
        console.log(prompt);
        
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: prompt }],
            temperature: 0.3,
        });

        const aiBidRaw = completion.choices[0].message.content;

        // **Step 8.5: Clean JSON response before parsing**
        const match = aiBidRaw.match(/```json\n([\s\S]*?)\n```/);
        let aiBidClean = match ? match[1].trim() : aiBidRaw.trim();

        let aiBid;
        try {
            aiBid = JSON.parse(aiBidClean);
            console.log(`✅ AI-Generated Bid for Business ${businessId} (${category}):`, aiBid);
        } catch (error) {
            console.error("❌ Error parsing AI bid response:", aiBidClean, error);
            return null;
        }

        // Step 8.5: Validate and adjust pricing based on business constraints
        aiBid = validateAndAdjustPricing(aiBid, pricingRules, trainingData);
        
        // Use the calculated final price instead of AI-generated price
        aiBid.bidAmount = context.finalPrice;
        
        console.log(`💰 Final calculated bid: $${aiBid.bidAmount}`);

        // Step 9: Determine Bid Category
        const bidCategory = ["photography", "videography"].includes(category) 
            ? "Photography" 
            : "General";

        // **Step 10: Insert AI-generated bid into Supabase**
        const { error: insertError } = await supabase
            .from("bids")
            .insert([
                {
            request_id: requestDetails.id,
            user_id: businessId,
            bid_amount: aiBid.bidAmount,
            bid_description: aiBid.bidDescription,
            category: bidCategory,
            status: "pending",
            hidden: null
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

// Helper function to get business training data
async function getBusinessTrainingData(businessId, category) {
    try {
        // Fetch business responses for this category
        const { data: responses, error: responsesError } = await supabase
            .from('autobid_training_responses')
            .select(`
                *,
                autobid_training_requests(request_data)
            `)
            .eq('business_id', businessId)
            .eq('category', category)
            .eq('is_training', true)
            .eq('is_ai_generated', false)
            .order('created_at', { ascending: true });

        if (responsesError) {
            console.warn("⚠️ Error fetching training responses:", responsesError.message);
            return { responses: [], feedback: [] };
        }

        // Fetch feedback data
        const { data: feedback, error: feedbackError } = await supabase
            .from('autobid_training_feedback')
            .select('*')
            .eq('business_id', businessId)
            .order('created_at', { ascending: true });

        if (feedbackError) {
            console.warn("⚠️ Error fetching feedback:", feedbackError.message);
            return { responses: responses || [], feedback: [] };
        }

        return { responses: responses || [], feedback: feedback || [] };
    } catch (error) {
        console.warn("⚠️ Error in getBusinessTrainingData:", error.message);
        return { responses: [], feedback: [] };
    }
}

// Enhanced AI prompt function that incorporates training data
const getEnhancedCategorySpecificPrompt = (category, requestData, pricingRules, bidHistory, trainingData, businessPackages, context) => {
    // Process training data for AI
    const processedTrainingData = processTrainingDataForAI(trainingData);
    
    // Format pricing rules for AI consumption
    const formatPricingRules = (rules) => {
        if (!rules) return "No pricing rules configured";
        
        return `
**PRICING RULES CONFIGURATION:**
- **Category:** ${rules.category || 'Not specified'}
- **Pricing Model:** ${rules.pricing_model || 'Not specified'}
- **Base Price:** $${rules.base_price || 'Not set'}
- **Hourly Rate:** $${rules.hourly_rate || 'Not set'}
- **Per Person Rate:** $${rules.per_person_rate || 'Not set'}
- **Travel Fee:** $${rules.travel_fee_per_mile || 'Not set'} per mile
- **Bid Aggressiveness:** ${rules.bid_aggressiveness || 'Not specified'}
- **Accept Unknowns:** ${rules.accept_unknowns ? 'Yes' : 'No'}
- **Rush Fee:** ${rules.rush_fee_percent || 'Not set'}%
- **Deposit:** ${rules.deposit_percent || 'Not set'}%
- **Min Booking Notice:** ${rules.min_booking_notice_hours || 'Not set'} hours
- **Min Duration:** ${rules.min_duration_hours || 'Not set'} hours
- **Require Consultation:** ${rules.require_consultation ? 'Yes' : 'No'}
- **Max Distance:** ${rules.max_distance_miles || 'Not set'} miles
- **Platform Markup:** ${rules.platform_fee_markup_percent || 'Not set'}%
- **Include Tax:** ${rules.include_tax ? 'Yes' : 'No'}
- **Tax Rate:** ${rules.tax_rate_percent || 'Not set'}%

**MULTIPLIERS & DISCOUNTS:**
- **Holiday Multiplier:** ${rules.holiday_multiplier || 'Not set'}
- **Weekend Multiplier:** ${rules.weekend_multiplier || 'Not set'}
- **Evening Multiplier:** ${rules.evening_multiplier || 'Not set'}
- **Morning Discount:** ${rules.morning_discount_percent || 'Not set'}%
- **Long Booking Discount:** ${rules.discount_for_long_booking_percent || 'Not set'}% (after ${rules.long_booking_hours_threshold || 'Not set'} hours)

**TRAVEL & LOGISTICS:**
- **Travel Included Miles:** ${rules.travel_included_miles || 'Not set'}
- **Per Mile Overage Fee:** $${rules.per_mile_overage_fee || 'Not set'}
- **Base Price Includes Hours:** ${rules.base_price_includes_hours || 'Not set'}

**SERVICE SPECIFICS:**
- **Image Style:** ${rules.image_style || 'Not specified'}
- **Editing Style:** ${rules.editing_style || 'Not specified'}
- **Turnaround Time:** ${rules.turnaround_time_days || 'Not set'} days
- **Print Rights Included:** ${rules.print_rights_included ? 'Yes' : 'No'}
- **Online Gallery Included:** ${rules.online_gallery_included ? 'Yes' : 'No'}
- **Watermark Images:** ${rules.watermark_images ? 'Yes' : 'No'}

**LOCATION PREFERENCES:**
- **Preferred Locations:** ${rules.preferred_locations || 'None specified'}
- **Excluded Locations:** ${rules.excluded_locations || 'None specified'}

**COMPLEX DATA:**
- **Base Category Rates:** ${rules.base_category_rates ? JSON.stringify(rules.base_category_rates) : 'Not configured'}
- **Travel Config:** ${rules.travel_config ? JSON.stringify(rules.travel_config) : 'Not configured'}
- **Platform Markup:** ${rules.platform_markup ? JSON.stringify(rules.platform_markup) : 'Not configured'}
- **Consultation Required:** ${rules.consultation_required ? 'Yes' : 'No'}
- **Dealbreakers:** ${rules.dealbreakers ? JSON.stringify(rules.dealbreakers) : 'None'}
- **Style Preferences:** ${rules.style_preferences ? JSON.stringify(rules.style_preferences) : 'Not configured'}`;
    };
    
    // Format business packages for AI consumption
    const formatBusinessPackages = (packages) => {
        if (!packages || packages.length === 0) return "No packages configured";
        
        return packages.map(pkg => `
**PACKAGE: ${pkg.name}**
- **Price:** $${pkg.price}
- **Description:** ${pkg.description || 'No description'}
- **Features:** ${pkg.features ? pkg.features.join(', ') : 'No features listed'}
- **Display Order:** ${pkg.display_order || 'Not specified'}`).join('\n\n');
    };
    
    const basePrompt = `
        You are an AI assistant that generates conversation-starting bids for ${category} services. Your goal is to provide an accurate base offer with smart upsell suggestions, not perfect pricing.

        ### **Business Profile**
        - **ID:** ${requestData.businessId}  
        - **Category:** ${pricingRules?.category || 'Not specified'}

        ### **BUSINESS PRICING RULES (FOUNDATION)**
        ${formatPricingRules(pricingRules)}

        ### **BUSINESS PACKAGES (AVAILABLE OPTIONS)**
        ${formatBusinessPackages(businessPackages)}

        ### **BASE PRICING CALCULATION:**
        - **Base Price:** $${context.basePrice}
        - **Platform Markup:** ${pricingRules?.platform_fee_markup_percent ? `${pricingRules.platform_fee_markup_percent}%` : 'None'}
        - **Final Base Price:** $${context.finalPrice}
        - **Travel Warning:** ${context.travelFees.warning || 'None'}

        ### **CONSULTATION REQUIREMENTS:**
        ${pricingRules?.require_consultation ? 'MUST include consultation call requirement.' : 'No consultation call required.'}

        ### **Business Training Patterns**
        - **Average Training Bid Amount:** $${processedTrainingData.business_patterns.average_bid_amount.toFixed(2)}
        - **Service Emphasis from Training:** ${processedTrainingData.service_preferences.join(', ')}
        - **Description Style from Training:** ${processedTrainingData.business_patterns.description_style}
        - **Training Feedback Approval Rate:** ${(processedTrainingData.feedback_preferences.approval_rate * 100).toFixed(1)}%

        ### **CRITICAL FEEDBACK LEARNING:**
        - **Pricing Adjustments Needed:** ${processedTrainingData.feedback_preferences.pricing_adjustments.join(', ') || 'none'}
        - **Common Issues to Avoid:** ${processedTrainingData.feedback_preferences.common_issues.join(', ') || 'none'}
        - **Specific Feedback Received:** ${processedTrainingData.feedback_preferences.specific_feedback.slice(0, 3).join(' | ') || 'none'}
        - **Preferred Improvements:** ${processedTrainingData.feedback_preferences.preferred_improvements.slice(0, 2).join(' | ') || 'none'}

        ### **PRICING ADJUSTMENT INSTRUCTIONS:**
        ${processedTrainingData.feedback_preferences.pricing_adjustments.includes('reduce_pricing') ? 
          '⚠️ CRITICAL: Previous feedback indicates pricing was TOO HIGH. Reduce your bid amount by 15-25% from the business base price.' : ''}
        ${processedTrainingData.feedback_preferences.pricing_adjustments.includes('increase_pricing') ? 
          '⚠️ CRITICAL: Previous feedback indicates pricing was TOO LOW. Increase your bid amount by 15-25% from the business base price.' : ''}
        ${processedTrainingData.feedback_preferences.pricing_adjustments.length === 0 ? 
          '✅ No major pricing issues identified in feedback. Use business pricing rules as baseline.' : ''}

        ### **Past Bid History:**  
        ${bidHistory}

        ### **New Service Request**  
        ${requestData.formattedRequest}

        ### **Category-Specific Bidding Strategy**
        ${requestData.categoryStrategy}

        ### **PRICING CALCULATION INSTRUCTIONS (CRITICAL)**
        **PRIMARY PRICING FOUNDATION:** Use the business's explicit pricing rules as your starting point, NOT training averages.

        1. **USE CALCULATED PRICE:** The final price of $${context.finalPrice} has already been calculated using:
           - Base category rate: $${context.basePrice}
           - Travel fees: $${context.travelFees.fee}
           - Platform markup: ${pricingRules?.platform_markup ? `${pricingRules.platform_markup}%` : 'None'}

        2. **CATEGORY-SPECIFIC PRICING MODEL:**
           ${pricingRules?.category === 'photography' || pricingRules?.category === 'videography' ? `
           **PHOTOGRAPHY/VIDEOGRAPHY:**
           - Wedding: $${pricingRules?.base_category_rates?.wedding || 'Not set'}
           - Couple/Engagement: $${pricingRules?.base_category_rates?.couple || 'Not set'}
           - Family/Portrait: $${pricingRules?.base_category_rates?.family || 'Not set'}` : ''}
           
           ${pricingRules?.category === 'catering' ? `
           **CATERING:**
           - Base rate: $${pricingRules?.base_category_rates?.catering || 'Not set'}
           - Per-person: $${pricingRules?.per_person_rates?.base || 'Not set'} + $${pricingRules?.per_person_rates?.additionalPerson || 'Not set'} per additional person` : ''}
           
           ${pricingRules?.category === 'dj' ? `
           **DJ:**
           - First hour: $${pricingRules?.hourly_tiers?.firstHour || 'Not set'}
           - Additional hours: $${pricingRules?.hourly_tiers?.additionalHours || 'Not set'}` : ''}

        3. **TRAVEL & LOGISTICS:**
           - Travel fees: $${context.travelFees.fee}${context.travelFees.warning ? ` - ${context.travelFees.warning}` : ''}
           - Include travel warnings in bid message if applicable

        4. **CONSULTATION REQUIREMENTS:**
           ${pricingRules?.consultation_required ? 
             '⚠️ ALWAYS mention scheduling a consultation call before providing final quote. Example: "I\'d love to schedule a quick call to discuss your specific needs and provide a final quote."' : 
             'No consultation call required.'}

        5. **PACKAGE SUGGESTIONS:**
           - Suggest relevant packages from the business packages list
           - Use package pricing as alternative to calculated pricing when appropriate

        6. **UPSELL OPPORTUNITIES:**
           - Mention relevant add-ons based on the request
           - Keep suggestions non-aggressive and optional
           - Focus on value-add services

        7. **FINAL VALIDATION:**
           - Use the calculated final price: $${context.finalPrice}
           - Ensure price is reasonable ($50-$50k range)
           - Match business's bid aggressiveness level
           - Avoid blocklist_keywords: ${pricingRules?.blocklist_keywords ? JSON.stringify(pricingRules.blocklist_keywords) : 'None'}

        ### **Training Data Integration Instructions**
        Use the business's training patterns to enhance your bid (but don't override pricing rules):
        1. **Follow their pricing strategy** - Use their preferred pricing approach
        2. **Emphasize their preferred services** - Highlight services they typically include
        3. **Match their description style** - Use their preferred level of detail
        4. **AVOID THESE ISSUES:** ${processedTrainingData.feedback_preferences.common_issues.join(', ') || 'none'}
        5. **INCORPORATE THESE IMPROVEMENTS:** ${processedTrainingData.feedback_preferences.preferred_improvements.slice(0, 2).join(' | ') || 'none'}

        ### **CRITICAL PRICING ACCURACY REQUIREMENTS:**
        1. **PRIMARY:** Use business pricing rules as foundation
        2. **SECONDARY:** Apply training data insights for enhancement
        3. **TERTIARY:** Use market rates as validation
        4. **FINAL:** Ensure all business constraints are respected

        ### **Return JSON format ONLY:**  
        \`\`\`json
        {
            "bidAmount": <calculated bid price - must be a number>,
            "bidDescription": "<detailed bid description matching business style>"
        }
        \`\`\`
    `;

    return basePrompt;
};

// Process training data for AI (reused from training system)
function processTrainingDataForAI(trainingData) {
    const processedData = {
        business_patterns: analyzeBusinessPatterns(trainingData.responses),
        pricing_strategy: extractPricingStrategy(trainingData.responses),
        feedback_preferences: analyzeFeedbackPreferences(trainingData.feedback),
        service_preferences: extractServicePreferences(trainingData.responses)
    };

    return processedData;
}

function analyzeBusinessPatterns(responses) {
    const patterns = {
        average_bid_amount: 0,
        pricing_factors: [],
        service_emphasis: [],
        description_style: ''
    };

    if (responses.length > 0) {
        // Calculate average bid amount
        const totalAmount = responses.reduce((sum, response) => sum + parseFloat(response.bid_amount), 0);
        patterns.average_bid_amount = totalAmount / responses.length;

        // Analyze pricing breakdown patterns
        patterns.pricing_factors = extractPricingFactors(responses);

        // Analyze service emphasis
        patterns.service_emphasis = extractServiceEmphasis(responses);

        // Analyze description style
        patterns.description_style = analyzeDescriptionStyle(responses);
    }

    return patterns;
}

function extractPricingStrategy(responses) {
    const strategies = {
        premium_pricing: false,
        competitive_pricing: false,
        value_based_pricing: false,
        cost_plus_pricing: false
    };

    // Analyze pricing reasoning to determine strategy
    responses.forEach(response => {
        const reasoning = response.pricing_reasoning?.toLowerCase() || '';

        if (reasoning.includes('premium') || reasoning.includes('high-end')) {
            strategies.premium_pricing = true;
        }
        if (reasoning.includes('competitive') || reasoning.includes('market rate')) {
            strategies.competitive_pricing = true;
        }
        if (reasoning.includes('value') || reasoning.includes('quality')) {
            strategies.value_based_pricing = true;
        }
        if (reasoning.includes('cost') || reasoning.includes('overhead')) {
            strategies.cost_plus_pricing = true;
        }
    });

    return strategies;
}

function extractPricingFactors(responses) {
    const factors = [];
    responses.forEach(response => {
        const breakdown = response.pricing_breakdown?.toLowerCase() || '';
        if (breakdown.includes('hour') || breakdown.includes('time')) factors.push('hourly_rate');
        if (breakdown.includes('person') || breakdown.includes('guest')) factors.push('per_person');
        if (breakdown.includes('equipment') || breakdown.includes('gear')) factors.push('equipment');
        if (breakdown.includes('travel') || breakdown.includes('mileage')) factors.push('travel');
        if (breakdown.includes('editing') || breakdown.includes('post')) factors.push('post_production');
    });
    return [...new Set(factors)];
}

function extractServiceEmphasis(responses) {
    const emphasis = [];
    responses.forEach(response => {
        const description = response.bid_description?.toLowerCase() || '';
        if (description.includes('premium') || description.includes('luxury')) emphasis.push('premium_quality');
        if (description.includes('experience') || description.includes('professional')) emphasis.push('experience');
        if (description.includes('package') || description.includes('complete')) emphasis.push('comprehensive_packages');
        if (description.includes('custom') || description.includes('personalized')) emphasis.push('customization');
    });
    return [...new Set(emphasis)];
}

function analyzeDescriptionStyle(responses) {
    const descriptions = responses.map(r => r.bid_description || '').join(' ');
    const wordCount = descriptions.split(' ').length;
    
    if (wordCount > 200) return 'detailed';
    if (wordCount > 100) return 'moderate';
    return 'concise';
}

function analyzeFeedbackPreferences(feedback) {
    const preferences = {
        approval_rate: 0,
        common_issues: [],
        pricing_adjustments: [],
        specific_feedback: [],
        preferred_improvements: []
    };

    if (feedback.length > 0) {
        const approvals = feedback.filter(f => f.feedback_type === 'approved').length;
        preferences.approval_rate = approvals / feedback.length;

        // Extract detailed feedback analysis from rejected feedback
        const rejectedFeedback = feedback.filter(f => f.feedback_type === 'rejected');
        const feedbackAnalysis = extractCommonIssues(rejectedFeedback);
        
        preferences.common_issues = feedbackAnalysis.issues;
        preferences.pricing_adjustments = feedbackAnalysis.pricingAdjustments;
        preferences.specific_feedback = feedbackAnalysis.specificFeedback;

        // Extract approved feedback patterns for positive learning
        const approvedFeedback = feedback.filter(f => f.feedback_type === 'approved');
        approvedFeedback.forEach(f => {
            if (f.feedback_text) {
                preferences.preferred_improvements.push(f.feedback_text);
            }
        });
    }

    return preferences;
}

function extractCommonIssues(rejectedFeedback) {
    const issues = [];
    const pricingAdjustments = [];
    const specificFeedback = [];

    rejectedFeedback.forEach(feedback => {
        const text = feedback.feedback_text?.toLowerCase() || '';
        const specificIssues = feedback.specific_issues || {};
        const suggestedImprovements = feedback.suggested_improvements || {};

        // Extract pricing-specific feedback
        if (text.includes('too high') || text.includes('expensive') || text.includes('overpriced')) {
            issues.push('pricing_too_high');
            pricingAdjustments.push('reduce_pricing');
        }
        if (text.includes('too low') || text.includes('cheap') || text.includes('underpriced')) {
            issues.push('pricing_too_low');
            pricingAdjustments.push('increase_pricing');
        }
        if (text.includes('missing') || text.includes('incomplete')) {
            issues.push('incomplete_description');
        }
        if (text.includes('wrong') || text.includes('incorrect')) {
            issues.push('incorrect_services');
        }

        // Extract specific feedback from structured data
        if (specificIssues.pricing) {
            issues.push(`pricing_${specificIssues.pricing}`);
            if (specificIssues.pricing === 'too_high') pricingAdjustments.push('reduce_pricing');
            if (specificIssues.pricing === 'too_low') pricingAdjustments.push('increase_pricing');
        }
        if (specificIssues.description) {
            issues.push(`description_${specificIssues.description}`);
        }
        if (specificIssues.services) {
            issues.push(`services_${specificIssues.services}`);
        }

        // Store specific feedback text for AI learning
        if (feedback.feedback_text) {
            specificFeedback.push(feedback.feedback_text);
        }
        if (suggestedImprovements) {
            specificFeedback.push(`Suggested: ${JSON.stringify(suggestedImprovements)}`);
        }
    });

    return {
        issues: [...new Set(issues)],
        pricingAdjustments: [...new Set(pricingAdjustments)],
        specificFeedback: specificFeedback
    };
}

function extractServicePreferences(responses) {
    const preferences = [];
    responses.forEach(response => {
        const description = response.bid_description?.toLowerCase() || '';
        if (description.includes('full day') || description.includes('complete coverage')) preferences.push('full_coverage');
        if (description.includes('engagement') || description.includes('pre-wedding')) preferences.push('engagement_sessions');
        if (description.includes('album') || description.includes('prints')) preferences.push('physical_products');
        if (description.includes('online') || description.includes('digital')) preferences.push('digital_delivery');
    });
    return [...new Set(preferences)];
}

// Pricing validation and adjustment function
function validateAndAdjustPricing(aiBid, pricingRules, trainingData) {
    let adjustedBid = { ...aiBid };
    const bidAmount = parseFloat(aiBid.bidAmount);
    
    console.log(`🔍 Validating bid amount: $${bidAmount}`);
    
    // PRIMARY: Apply business pricing constraints (highest priority)
    if (pricingRules) {
        const minPrice = parseFloat(pricingRules.min_price);
        const maxPrice = parseFloat(pricingRules.max_price);
        
        if (!isNaN(minPrice) && bidAmount < minPrice) {
            console.log(`⚠️ Bid $${bidAmount} below business minimum $${minPrice}, adjusting up`);
            adjustedBid.bidAmount = minPrice;
        }
        
        if (!isNaN(maxPrice) && bidAmount > maxPrice) {
            console.log(`⚠️ Bid $${bidAmount} above business maximum $${maxPrice}, adjusting down`);
            adjustedBid.bidAmount = maxPrice;
        }
        
        // Apply business-specific pricing adjustments
        if (pricingRules.base_price && !isNaN(pricingRules.base_price)) {
            const basePrice = parseFloat(pricingRules.base_price);
            console.log(`💰 Business base price: $${basePrice}`);
            
            // If the AI bid is significantly different from base price, consider adjusting
            const basePriceVariance = 0.3; // Allow 30% variance from base price
            const minBasePrice = basePrice * (1 - basePriceVariance);
            const maxBasePrice = basePrice * (1 + basePriceVariance);
            
            if (adjustedBid.bidAmount < minBasePrice) {
                console.log(`⚠️ Bid $${adjustedBid.bidAmount} significantly below base price $${basePrice}, adjusting up`);
                adjustedBid.bidAmount = Math.round(minBasePrice);
            }
            
            if (adjustedBid.bidAmount > maxBasePrice) {
                console.log(`⚠️ Bid $${adjustedBid.bidAmount} significantly above base price $${basePrice}, adjusting down`);
                adjustedBid.bidAmount = Math.round(maxBasePrice);
            }
        }
    }
    
    // SECONDARY: Apply training data insights (only if no business rules or as validation)
    if (trainingData.responses && trainingData.responses.length > 0 && (!pricingRules || !pricingRules.base_price)) {
        const avgTrainingBid = trainingData.responses.reduce((sum, r) => sum + parseFloat(r.bid_amount), 0) / trainingData.responses.length;
        const trainingVariance = 0.2; // Allow 20% variance from training average
        
        const minTrainingPrice = avgTrainingBid * (1 - trainingVariance);
        const maxTrainingPrice = avgTrainingBid * (1 + trainingVariance);
        
        if (adjustedBid.bidAmount < minTrainingPrice) {
            console.log(`⚠️ Bid $${adjustedBid.bidAmount} below training minimum $${minTrainingPrice.toFixed(2)}, adjusting up`);
            adjustedBid.bidAmount = Math.round(minTrainingPrice);
        }
        
        if (adjustedBid.bidAmount > maxTrainingPrice) {
            console.log(`⚠️ Bid $${adjustedBid.bidAmount} above training maximum $${maxTrainingPrice.toFixed(2)}, adjusting down`);
            adjustedBid.bidAmount = Math.round(maxTrainingPrice);
        }
    }
    
    // TERTIARY: Ensure bid is a reasonable amount (not too low or too high)
    const finalAmount = Math.max(50, Math.min(50000, adjustedBid.bidAmount)); // $50-$50k range
    if (finalAmount !== adjustedBid.bidAmount) {
        console.log(`⚠️ Bid adjusted to reasonable range: $${finalAmount}`);
        adjustedBid.bidAmount = finalAmount;
    }
    
    console.log(`✅ Final validated bid amount: $${adjustedBid.bidAmount}`);
    return adjustedBid;
}

// Helper function to check dealbreakers
function checkDealbreakers(requestData, pricingRules) {
    if (!pricingRules.dealbreakers || pricingRules.dealbreakers.length === 0) {
        return { allowed: true, violations: [] };
    }
    
    // Convert request data to searchable text
    const requestText = JSON.stringify(requestData).toLowerCase();
    const additionalComments = requestData.additional_comments?.toLowerCase() || '';
    const specialRequests = requestData.special_requests?.toLowerCase() || '';
    const fullText = `${requestText} ${additionalComments} ${specialRequests}`;
    
    // Check for dealbreaker violations
    const violations = pricingRules.dealbreakers.filter(dealbreaker => 
        fullText.includes(dealbreaker.toLowerCase())
    );
    
    return {
        allowed: violations.length === 0,
        violations
    };
}

// Helper function to calculate travel fees
function calculateTravelFees(vendorLocation, eventLocation, travelConfig) {
    if (!travelConfig || !vendorLocation || !eventLocation) {
        return { fee: 0, warning: null };
    }
    
    // Simple distance calculation (in production, use Google Maps API)
    // For now, we'll use a placeholder that can be enhanced later
    const distance = 25; // Placeholder - would calculate actual distance
    
    if (distance <= travelConfig.freeDistance) {
        return { fee: 0, warning: null };
    }
    
    const fee = (distance - travelConfig.freeDistance) * travelConfig.drivingRate;
    return { 
        fee: Math.round(fee), 
        warning: travelConfig.travelWarning 
    };
}

// Helper function to apply seasonal pricing
function applySeasonalPricing(basePrice, eventDate, seasonalPricing) {
    if (!seasonalPricing || !eventDate) {
        return basePrice;
    }
    
    const month = new Date(eventDate).getMonth();
    const seasonalMultiplier = seasonalPricing[month] || 1.0;
    return Math.round(basePrice * seasonalMultiplier);
}

// Helper function to calculate duration-based pricing
function calculateDurationPricing(duration, pricingRules) {
  if (!duration || !pricingRules.hourly_rate) {
    return parseFloat(pricingRules.base_price) || 0;
  }
  
  const hours = parseInt(duration.match(/(\d+)/)?.[1] || 1);
  const hourlyRate = parseFloat(pricingRules.hourly_rate);
  
  return Math.round(hourlyRate * hours);
}

// Helper function to calculate category-specific pricing
function calculateCategoryPricing(requestData, pricingRules) {
  const eventType = requestData.event_type?.toLowerCase();
  const guestCount = requestData.guest_count || requestData.estimated_guests || 1;
  const duration = requestData.duration;
  
  // Start with base price
  let basePrice = parseFloat(pricingRules.base_price) || 0;
  
  // Apply hourly rate if duration is specified
  if (duration && pricingRules.hourly_rate) {
    const hours = parseInt(duration.match(/(\d+)/)?.[1] || 1);
    basePrice = parseFloat(pricingRules.hourly_rate) * hours;
  }
  
  // Apply per-person rate if applicable
  if (pricingRules.per_person_rate && guestCount > 1) {
    basePrice = parseFloat(pricingRules.per_person_rate) * guestCount;
  }
  
  // Apply rush fee if timeline is tight
  if (requestData.timeline === 'rush' && pricingRules.rush_fee_percent) {
    const rushFee = basePrice * (parseFloat(pricingRules.rush_fee_percent) / 100);
    basePrice += rushFee;
  }
  
  // Apply multipliers based on time of day
  if (pricingRules.evening_multiplier && requestData.time_of_day === 'evening') {
    basePrice *= parseFloat(pricingRules.evening_multiplier);
  }
  
  if (pricingRules.weekend_multiplier && requestData.day_of_week === 'weekend') {
    basePrice *= parseFloat(pricingRules.weekend_multiplier);
  }
  
  if (pricingRules.holiday_multiplier && requestData.is_holiday) {
    basePrice *= parseFloat(pricingRules.holiday_multiplier);
  }
  
  return Math.round(basePrice);
}

// Export function
module.exports = { generateAutoBidForBusiness };