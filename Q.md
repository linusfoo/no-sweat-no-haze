# No Sweat, No Haze: Product Interview (Q&A)

(Working title during the interview: "Escape from CT Hub".)

Format: three questions per round, using the Five Whys (https://www.idg.gov.sg/product-thinking/).

## Round 1
**Q1. Who is the main person this app is for?**
A: The office crowd, though it could also be for lunch and so on. Maybe something to do with weather: if it's raining or the haze is bad, I could change my route home to spend less time outdoors (i.e. walking).

**Q2. Which moment hurts most? (which bus to run for / rain or no rain / car: park or cross / taxi or bus)**
A: All of them.

**Q3. What do you do today in that moment? (juggle several apps / gut feel / look outside / nothing)**
A: No preference given.

## Round 2
**Q4. Why 1: Why cut outdoor exposure when it rains or the haze is bad? What actually goes wrong?**
A: Arriving wet or sweaty (uncomfortable, looks bad), and health (haze, UV, heat).

**Q5. When does the decision actually happen?**
A: About 20–30 minutes before leaving.

**Q6. What does "modify my route" mean in practice?**
A: Switching to a different bus, the MRT or a taxi, and changing when I leave.

## Round 3
**Q7. Why 2: Why does arriving wet or breathing haze matter so much that you'd change your plans?**
A: Professional image (meetings, office), a health condition (asthma/allergies/heat sensitivity), and plain comfort.

**Q8. Where are the trips from and to?**
A: Both: the commute home and lunch runs, all from one office.

**Q9. With 20–30 minutes to go, what should the app show?**
A: Ranked options (bus / MRT / taxi / wait), each with outdoor minutes, rain risk and arrival time.

## Round 4
**Q10. Where exactly?**
A: Office is CT Hub (2 Kallang Ave).

**Q11. How should "outdoor minutes" be worked out for each option?**
A: Walking plus waiting: uncovered walking time plus time waiting at an open bus stop.

**Q12. How will you use it?**
A: In a laptop browser (local web page opened at my desk).

## Round 5
**Q13. What's your home area?**
A: Use a sample home (Tampines), so I don't have to share my real address.

**Q14. How should MRT be handled, given there's no free real-time MRT API?**
A: A static estimate (typical walk-to-station and train times), no DataMall key.

**Q15. Where should lunch spots come from?**
A: The app suggests nearby places.

**Feedback on plan:** include restaurants as well as hawker centres, within budget.

## Round 6
**Q16. What's your typical lunch budget per person?**
A: $8–$15.

**Q17. How should budget be judged? (OSM has places but rarely prices)**
A: OSM plus a curated mix: curated price tiers for known places, and OSM fills in the rest as "price unknown".

**Q18. How far would you go for lunch in good weather?**
A: A short bus ride is OK (up to about 2 km).

## What we agreed to build
A local laptop web app that ranks ways to leave CT Hub (to home or to lunch) by **outdoor exposure** (walking plus waiting), weighted by live rain, haze, UV and heat. Options are bus / MRT / taxi / wait 30 min. Lunch suggestions cover hawker centres and restaurants within a $8–15 budget and about 2 km.
