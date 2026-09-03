# air - design

Air is Aclima's strategic and tactical visual tool product. It is the airbitrator of air quality measurement and its interpretation and impact across three user types (and aclima admin, a 4th). Each user type gets a different experience, but the underlying data is the basis.

It will be one React web application with three separate interface type for different audiences + aclima admin interface. 

# scope
This is a demonstration. It is not expected to be a fully working system. Data can be mocked. Guesses can be made. Assumptions about EPA limits, modality units, user preferences, etc can be made and fixed later. Just make them tweakable.

# shared aspects

Aclima's air quality data (+ acoustic soon) data is spatial-temporal by nature. Maps are the natural way to visualize the spatial aspect. Line or bar graphs for timelines. The diurnal and seasonal patters are important. The data should be understood as a time series under intense analysis "what did air quality look like yesterday at 5pm" and general "what is the average persistence and magnitude of a pollutant at this location and timeframe".

The user facing tools are all focused on a particular community. This is not a globally accessible map. A community polyline(s) is configured through the aclima admin side, that is all that can easily be accessed, and where the map naturally centers. Everything spatial focuses on the community.

While auth is not structly needed for this prototype, user management still is key as users must have roles that segregate them into the 4 different user groups.

## Campaigns
This is the canonical way aclima operates A campaign will be created by the admin interface as a geographicaly and temporally limited region. A drive plan is then created within this and tweaked until the drive plan is efficient and provides enough coverage. A drive plan is literally a sequence of road segments for driving, over and over. A fleet of several cars will carry out a drive plan that, combined, covers the entire campaign area with enough passes per segment (at least 20 passes)

## Segments
The data aclima stores about ambient concentrations is not just lat/lon or hexgrid. It is associated with a particular road segment. So given the gps coords of the measurement it is "snapped" to a road segment. This crosses over to the visual expression in the UI. **The flagship visualization of aclima mobile monitoring data is not hex or points, it is a colored road grid, with the road segments colored by intensity of pollutant modality magnitude and/or persistence.**

# specifics
Because of the nature of the current business pivot, industry almost === datacenters. That's our focus. But it could include other industries that emit air pollution.

# build constraints

## data generation
This is a demonstration of capability. Most of our SMMI data is in a incredibly messy BigQuery sprawl. We do have a CARTO api key that might connect to right table in .env I set up. It is optional to attempt to try to connect to it. We only have data for some of Illinois and California small patches of communities. Procedurally generated data might be a better idea. The data is road segment oriented. For each 200 meter average length of a road in the monitoring area, a segment will be generated, with all the modalities. I would generate the simulated data by doing a fake driveplan that generates that data, use the chinese traveling salesperson algorithm to drive the polyline deliminted campaign until each segment has at least 20 passes. Use some kind of biased noise generator to create the magnitude of each modality based on some kind of precalculated field. Think minecraft terrain generation. First build the field, then run the drive in the field and the segment pick up the value they are in. Change the field over time so it's not just the same data.

## persistence
While this is a demo, I think there is enough "mass" here to require a database since the
three interfaces will share info. And if this is used for demos, having to create from scratch would suck. Feel free to use sqlite for a shared schema. Or propose other idea. 
Why I think a db makes sense is for the cross interface interactions like, a community member proposes a concern, and then the industry and regulator interfaces see it pop up.

## stack
I am most familiar with React + Tanstack. Team has used deck.gl. There has been a preference for google base maps. I'm partial to python FastAPI backends. However, our frontend engineer uses node. Either way works. Your call.

# audiences

## community 

Communities want to observe their environment for environmental threats to them and their community. They want to report concerns, weird smells, annoying sounds, signs of generators running all day. They want to see what other concerns have been reported by their community near them. This should be dominated by:

* Report Air Concern
* View Other Concerns (Map or List)
* Community Dashboard
* Regulatory Status
* Industry Outreach Presence

It must not be difficult to understand. This is not a data science product, it is for people
that don't know what PM2.5 is. Mangitude of modalities or indicators should be presented as unit-less "risk" scores.

The Regulatory Status is how the regulator can share their reading with the community. There are usually a few very high quality stationary data sensors maintained by the EPA or its state agencies. These are often scattered around random gov webpages. This gives a place to centralize their reading and regulator messages / warnings.

The Industry Outreach is how industry can message, express their interestin cooperating with community. They can post updates about their datacenter or factory, mitigations they have done, and critically, can propose that they have attempted to fix community concerns. They can't **close** community concerns, but they can report that they have tried to mitigate.

The visual narrative is a social media app. They can communicate their concerns, see a map, see what others are worried about, see the ground truth from "influencers" (regulators, industry). 

Users should be able to see where our cars are to generate curiosity, but delayed in time to avoid stalking.

## regulatory
Regulators are interested in measurement and compliance. They operate a few highly accurate and precise sensors. These are often few and far between, however, they are the only devices the EPA accepts as the gold standard. It is important for them to have their sensor data shared with their communities, as they are a government service to the community. 

This interface being FOR the regulator is highly detailed. Exact ambient concentrations of modalities. Detailed information about persistence, magnitude of concentrations. They usually have data scientist on staff and can both use detailed map and temporal interfaces.

They will be interested in how the alclima data allows a "leapfrogging" of their measurement closer to the emitters. While they don't usually trust our mobile monitoring data on it's own, since we calibrate our mobile monitors against their stationary sensors, and they usually trust our **precision** within distance related bounds they trust us to expand their reach. 

Their map view should be stationary sensor-centric. That's where they sense, and mobile monitoring should be an extension of that capability. 

What actions they really care about is, are reading over national regulatory contraints. This is their call to action, this is when they must warn the community or demand action from industry. Therefore **action levels** should be defineable by the regulator in the UI foreach modality, and visually clear alerts should pop up if they are exceeded. This can be a spike in **magnitude** or an extended emission that reaches some integrated level of exposure. In these cases they will want to push messages to the community and information/warnings to industry emitters.

The visual narrative is like a tower defense game. They have stationary sensors they manage, their "towers", a mobile fleet that extends their reach to "defend" against excessive emission, and "invaders" the suspected emitters.

Regulators will be interested in wind dispersion as well. Wind modeling like that avilable from Nvidia's Earth-2 data might be interesting. Their interest is broad area and again, centered on their towers and the entire region they are responsible for. 

Regulators might have some interest in where our cars are and should be able to see it. We can simulate ongoing drives via pre-calculated drive plans. Could be little balls moving around the roads on the drive plan.

## industry
Industry members, especially datacenters are trying to minmax their compute. They want to maximize how much compute they can build or run without getting blocked or penalized by the community or regulator. They will have one or more buildings that can be considered as one or a collection of point source emitters. They may have a ring of stationary sensors to attempt to track their emissions. 

Their interface is going to be focused on events. Most datacenter builders / operators do NOT want to have to care about air quality. What we can offer them is an event oriented portal that directs them to solutions. If they are about to emit too much of a modality on their east flank - warning telling them how much and exactly the direction - and recommend a resolution. A chatbot with an LLM might be helpful here for these recommendations. Another warning for them would come from a number of community concerns getting accepted at same time.

The visual narrative would be a higly abstracted version of an early warning radar in a military aircraft. The RWR shows a radial indicator of direction and distance to "threats", radar signatures. This is really what the industry cares about. What's the problem, where. Needs to be instantly understandable. Push notices. Simple. They don't want to dig into it or do analysis. The stationary sensors and community concerns are their threats. aclima is their passive radar.

For example. They get a warning that the regulatory stationary sensor for ozone is going over the max limit. They get a visual alert on a map and a timeline, direction, distance, severity. Alerts live on a timeline so they can see how long these are ongoing. Then they can compare to aclima's sensing via mobile monitors. "Is this a real problem or is the stationary sensor freaking out". Possibly even plug in their own stationary sensor network as well.

Another example. A cluster of community concerns starts popping up to the South East. The get an alert. They check EPA, aclima, and their internal sensors. They see that they have a leak. The push a message to community that they acknowledge and are working on it. 

Other than the early warning radar narrative, they also have a bit of a "community outreach portal" in nano scale. A little customizeable page where they can post their company logo, claim their industry building on the map, push messages and posts.

EDIT: Wind is also SUPER important. Industries will have their point source dispersion modeled by consultants. Verifiying that expensive results vs our wind monitors on our cars (yes we can measure wind on our mobile sensors) might be very useful. This should show up as a visual field overlay on the radial RWR inspired "locked onto a specific datacenter" bulding UI.

## aclima admin 
This is where a campaign is built. This starts with drawing a polyline (or more than one) on a map to limit the area of concern. This is where the user interfaces will all lock on for the other user groups. 

Then the simulated data can be generated of the mobile monitoring. A simulated drive plan will be generated. Both are complimentary as the drive plan can be used with same or similar algorithm to generate the data as well as create the plan for the cars to be driving around in "live" mode once campaign is complete.

A critical part of the driveplan is how many vehicles are available. There will be a fleet of a certain size available.

Admins can see everything. All the community concerns in a list/map. All the industry installations that have been claimed, their posts and outreach, their alerts. The regulatory actions as well. The interface would be closest to the regulatory interface.

# Backend
While not strictly required I can see it being useful to have a backend for user management, storing drive plans, simulated smmi data, messages, posts, commmunity concerns, stationary monitors, vehicle fleet, vehicles, industry sites, etc.