import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  filterPath,
  TripItApiError,
  TripItClient,
  type TripItCredentials,
} from "./tripit-client";

const SERVER_VERSION = "2.0.0";

// Object types TripIt supports for get/list/delete. "weather" is read-only.
const OBJECT_TYPES = [
  "air",
  "activity",
  "car",
  "cruise",
  "directions",
  "lodging",
  "map",
  "note",
  "parking",
  "rail",
  "restaurant",
  "transport",
  "weather",
] as const;

// Types that can be created/replaced, mapped to the JSON payload key TripIt
// expects (e.g. {"AirObject": {...}} for POST /create).
const WRITABLE_OBJECT_KEYS = {
  air: "AirObject",
  activity: "ActivityObject",
  car: "CarObject",
  cruise: "CruiseObject",
  directions: "DirectionsObject",
  lodging: "LodgingObject",
  map: "MapObject",
  note: "NoteObject",
  parking: "ParkingObject",
  rail: "RailObject",
  restaurant: "RestaurantObject",
  transport: "TransportObject",
} as const;

type WritableObjectType = keyof typeof WRITABLE_OBJECT_KEYS;
const WRITABLE_OBJECT_TYPES = Object.keys(WRITABLE_OBJECT_KEYS) as [
  WritableObjectType,
  ...WritableObjectType[],
];

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format");

const timeString = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, "Must be in HH:MM or HH:MM:SS format");

const tripIdParam = z
  .string()
  .describe("TripIt trip ID (the `id` field of a Trip from tripit_list_trips)");

const optionalTripIdParam = z
  .string()
  .optional()
  .describe(
    "Trip to file this under (optional). Omitted items are auto-filed by TripIt based on dates.",
  );

const objectTypeParam = z
  .enum(OBJECT_TYPES)
  .describe(`Travel object type. One of: ${OBJECT_TYPES.join(", ")}`);

const addressSchema = z
  .object({
    address: z.string().optional().describe("Street address"),
    city: z.string(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country: z.string(),
  })
  .describe("Location address; city and country are required");

const modifiedSinceParam = z
  .number()
  .int()
  .optional()
  .describe(
    "Unix timestamp (seconds). Only return items modified after this time — use for incremental sync.",
  );

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof TripItApiError
      ? error.message
      : error instanceof Error
        ? `Request failed: ${error.message}`
        : "Request failed with an unknown error";
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
const CREATES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const REPLACES = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
const DELETES = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Builds a fresh McpServer wired to the TripIt API v1 with the caller's
 * OAuth credentials.
 *
 * A new instance must be created per request: createMcpHandler() is
 * stateless and the MCP SDK forbids reconnecting an already-connected server.
 */
export function buildServer(credentials: TripItCredentials): McpServer {
  const client = new TripItClient(credentials);

  const server = new McpServer({
    name: "tripit",
    version: SERVER_VERSION,
  });

  // ==========================================================================
  // Trips
  // ==========================================================================

  server.registerTool(
    "tripit_list_trips",
    {
      title: "List trips",
      description:
        "List the user's TripIt trips (upcoming by default; set include_past for completed trips). " +
        "Returns Trip objects with `id`, display_name, dates, and primary_location. " +
        "Paginated via page_num/page_size (TripIt defaults to 5 trips per page — raise page_size to see more). " +
        "Use a trip's `id` with tripit_get_trip for full detail including reservations.",
      annotations: READ_ONLY,
      inputSchema: {
        include_past: z
          .boolean()
          .optional()
          .describe("Include trips that have already ended (default: false)"),
        modified_since: modifiedSinceParam,
        include_objects: z
          .boolean()
          .optional()
          .describe(
            "Embed each trip's travel objects (flights, hotels, ...) in the response. Increases response size significantly (default: false)",
          ),
        traveler: z
          .enum(["true", "false", "all"])
          .optional()
          .describe(
            "Filter by whether the user is a traveler on the trip: true (default), false, or all",
          ),
        page_num: z.number().int().min(1).optional().describe("Page number, from 1"),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Trips per page (TripIt default: 5)"),
      },
    },
    async (args) => {
      try {
        return jsonResult(
          await client.request(
            filterPath("/list/trip", {
              past: args.include_past,
              modified_since: args.modified_since,
              include_objects: args.include_objects,
              traveler: args.traveler,
              page_num: args.page_num,
              page_size: args.page_size,
            }),
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_get_trip",
    {
      title: "Get trip details",
      description:
        "Get one trip by ID, including all its travel objects (flights, hotels, cars, activities, ...) " +
        "unless include_objects is false. Object IDs in the response work with tripit_get_object, " +
        "tripit_update_object, and tripit_delete_object.",
      annotations: READ_ONLY,
      inputSchema: {
        trip_id: tripIdParam,
        include_objects: z
          .boolean()
          .optional()
          .describe("Include the trip's travel objects (default: true)"),
      },
    },
    async ({ trip_id, include_objects }) => {
      try {
        return jsonResult(
          await client.request(
            filterPath(`/get/trip/id/${encodeURIComponent(trip_id)}`, {
              include_objects: include_objects !== false,
            }),
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_create_trip",
    {
      title: "Create a trip",
      description:
        "Create a new trip container in the user's TripIt account. Add flights, hotels, and other " +
        "reservations afterwards with the tripit_create_* tools, passing the returned trip `id`.",
      annotations: CREATES,
      inputSchema: {
        display_name: z
          .string()
          .describe('Trip name shown in TripIt (e.g. "Tokyo Business Trip")'),
        start_date: dateString.describe("Trip start date, YYYY-MM-DD"),
        end_date: dateString.describe("Trip end date, YYYY-MM-DD"),
        primary_location: z
          .string()
          .optional()
          .describe('Main destination (e.g. "Tokyo, Japan")'),
        description: z.string().optional().describe("Trip notes or description"),
      },
    },
    async (args) => {
      try {
        return jsonResult(
          await client.request("/create", { method: "POST", jsonBody: { Trip: args } }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_update_trip",
    {
      title: "Update (replace) a trip",
      description:
        "Replace a trip's details. TripIt's update is a full replace: fields you omit are cleared, " +
        "so fetch the trip first (tripit_get_trip) and resend every field you want to keep.",
      annotations: REPLACES,
      inputSchema: {
        trip_id: tripIdParam,
        display_name: z.string().describe("Trip name"),
        start_date: dateString.describe("Trip start date, YYYY-MM-DD"),
        end_date: dateString.describe("Trip end date, YYYY-MM-DD"),
        primary_location: z.string().optional().describe("Main destination"),
        description: z.string().optional().describe("Trip notes or description"),
      },
    },
    async ({ trip_id, ...trip }) => {
      try {
        return jsonResult(
          await client.request(`/replace/trip/id/${encodeURIComponent(trip_id)}`, {
            method: "POST",
            jsonBody: { Trip: trip },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_delete_trip",
    {
      title: "Delete a trip",
      description:
        "Permanently delete a trip and all travel objects filed under it. This cannot be undone — " +
        "confirm with the user before deleting.",
      annotations: DELETES,
      inputSchema: {
        trip_id: tripIdParam,
      },
    },
    async ({ trip_id }) => {
      try {
        await client.request(`/delete/trip/id/${encodeURIComponent(trip_id)}`);
        return jsonResult({ deleted: true, trip_id });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // ==========================================================================
  // Travel objects
  // ==========================================================================

  server.registerTool(
    "tripit_list_objects",
    {
      title: "List travel objects",
      description:
        "List travel objects (reservations) across the user's account, filterable by type and/or trip. " +
        "Upcoming objects by default; set include_past for history. Returned IDs work with " +
        "tripit_get_object / tripit_update_object / tripit_delete_object.",
      annotations: READ_ONLY,
      inputSchema: {
        object_type: objectTypeParam
          .optional()
          .describe(
            `Only return objects of this type (${OBJECT_TYPES.join(", ")}). Omit for all types.`,
          ),
        trip_id: z
          .string()
          .optional()
          .describe("Only return objects filed under this trip"),
        include_past: z
          .boolean()
          .optional()
          .describe("Include objects from past trips (default: false)"),
        modified_since: modifiedSinceParam,
      },
    },
    async (args) => {
      try {
        return jsonResult(
          await client.request(
            filterPath("/list/object", {
              trip_id: args.trip_id,
              type: args.object_type,
              past: args.include_past,
              modified_since: args.modified_since,
            }),
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_get_object",
    {
      title: "Get a travel object",
      description:
        "Get full details of one travel object (a flight, hotel, car rental, activity, ...) by type and ID.",
      annotations: READ_ONLY,
      inputSchema: {
        object_type: objectTypeParam,
        object_id: z.string().describe("TripIt object ID"),
      },
    },
    async ({ object_type, object_id }) => {
      try {
        return jsonResult(
          await client.request(`/get/${object_type}/id/${encodeURIComponent(object_id)}`),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_create_flight",
    {
      title: "Add a flight",
      description:
        "Add a flight reservation (one AirObject) to TripIt. A connection itinerary is one call with " +
        "multiple segments. Without trip_id, TripIt auto-files it into a matching trip by date.",
      annotations: CREATES,
      inputSchema: {
        trip_id: optionalTripIdParam,
        confirmation_num: z.string().optional().describe("Booking confirmation number"),
        segments: z
          .array(
            z.object({
              start_date: dateString.describe("Departure date, YYYY-MM-DD"),
              start_time: timeString.describe("Departure time (airport-local)"),
              end_date: dateString.describe("Arrival date, YYYY-MM-DD"),
              end_time: timeString.describe("Arrival time (airport-local)"),
              start_airport_code: z
                .string()
                .describe('Origin airport IATA code (e.g. "SFO")'),
              end_airport_code: z
                .string()
                .describe('Destination airport IATA code (e.g. "NRT")'),
              marketing_airline_code: z.string().describe('Airline code (e.g. "UA")'),
              marketing_flight_number: z.string().describe('Flight number (e.g. "837")'),
              operating_airline_code: z.string().optional(),
              operating_flight_number: z.string().optional(),
              aircraft: z.string().optional().describe("Aircraft type"),
              seats: z.string().optional().describe('Seat assignment(s), e.g. "21A"'),
            }),
          )
          .min(1)
          .describe("Flight segments in order; connections are multiple segments"),
      },
    },
    async ({ trip_id, confirmation_num, segments }) => {
      try {
        const air: Record<string, unknown> = { Segment: segments };
        if (trip_id) air.trip_id = trip_id;
        if (confirmation_num) air.supplier_conf_num = confirmation_num;
        return jsonResult(
          await client.request("/create", {
            method: "POST",
            jsonBody: { AirObject: air },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_create_hotel",
    {
      title: "Add a hotel",
      description:
        "Add a hotel reservation (LodgingObject) to TripIt. Without trip_id, TripIt auto-files it " +
        "into a matching trip by date.",
      annotations: CREATES,
      inputSchema: {
        trip_id: optionalTripIdParam,
        supplier_name: z.string().describe("Hotel name"),
        start_date: dateString.describe("Check-in date, YYYY-MM-DD"),
        end_date: dateString.describe("Check-out date, YYYY-MM-DD"),
        check_in_time: timeString.optional().describe("Check-in time"),
        check_out_time: timeString.optional().describe("Check-out time"),
        confirmation_num: z.string().optional().describe("Booking confirmation number"),
        address: addressSchema,
        phone: z.string().optional().describe("Hotel phone number"),
        room_type: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async ({
      trip_id,
      address,
      check_in_time,
      check_out_time,
      confirmation_num,
      phone,
      ...rest
    }) => {
      try {
        const lodging: Record<string, unknown> = { ...rest, Address: address };
        if (trip_id) lodging.trip_id = trip_id;
        if (check_in_time)
          lodging.StartDateTime = { date: rest.start_date, time: check_in_time };
        if (check_out_time)
          lodging.EndDateTime = { date: rest.end_date, time: check_out_time };
        if (confirmation_num) lodging.supplier_conf_num = confirmation_num;
        if (phone) lodging.supplier_phone = phone;
        return jsonResult(
          await client.request("/create", {
            method: "POST",
            jsonBody: { LodgingObject: lodging },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_create_car",
    {
      title: "Add a car rental",
      description:
        "Add a car rental reservation (CarObject) to TripIt. Without trip_id, TripIt auto-files it " +
        "into a matching trip by date.",
      annotations: CREATES,
      inputSchema: {
        trip_id: optionalTripIdParam,
        supplier_name: z.string().describe('Rental company (e.g. "Hertz")'),
        start_date: dateString.describe("Pickup date, YYYY-MM-DD"),
        end_date: dateString.describe("Drop-off date, YYYY-MM-DD"),
        start_time: timeString.optional().describe("Pickup time"),
        end_time: timeString.optional().describe("Drop-off time"),
        pickup_location: addressSchema.describe("Pickup location address"),
        dropoff_location: addressSchema
          .optional()
          .describe("Drop-off location address (defaults to the pickup location)"),
        car_type: z.string().optional().describe('Car class (e.g. "Midsize SUV")'),
        confirmation_num: z.string().optional().describe("Booking confirmation number"),
      },
    },
    async (args) => {
      try {
        const car: Record<string, unknown> = {
          supplier_name: args.supplier_name,
          start_date: args.start_date,
          end_date: args.end_date,
          start_location_name: args.pickup_location.city,
          StartLocationAddress: args.pickup_location,
          end_location_name: (args.dropoff_location ?? args.pickup_location).city,
          EndLocationAddress: args.dropoff_location ?? args.pickup_location,
        };
        if (args.trip_id) car.trip_id = args.trip_id;
        if (args.start_time)
          car.StartDateTime = { date: args.start_date, time: args.start_time };
        if (args.end_time) car.EndDateTime = { date: args.end_date, time: args.end_time };
        if (args.car_type) car.car_type = args.car_type;
        if (args.confirmation_num) car.supplier_conf_num = args.confirmation_num;
        return jsonResult(
          await client.request("/create", {
            method: "POST",
            jsonBody: { CarObject: car },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_create_activity",
    {
      title: "Add an activity",
      description:
        "Add a generic activity (tour, event, meeting, dinner...) as an ActivityObject. Without " +
        "trip_id, TripIt auto-files it into a matching trip by date.",
      annotations: CREATES,
      inputSchema: {
        trip_id: optionalTripIdParam,
        display_name: z.string().describe("Activity name"),
        start_date: dateString.describe("Date, YYYY-MM-DD"),
        start_time: timeString.optional(),
        end_date: dateString.optional(),
        end_time: timeString.optional(),
        location_name: z.string().optional().describe("Venue or location name"),
        address: addressSchema.optional(),
        notes: z.string().optional(),
      },
    },
    async ({ trip_id, address, start_time, end_time, ...rest }) => {
      try {
        const activity: Record<string, unknown> = { ...rest };
        if (trip_id) activity.trip_id = trip_id;
        if (address) activity.Address = address;
        if (start_time)
          activity.StartDateTime = { date: rest.start_date, time: start_time };
        if (end_time && rest.end_date) {
          activity.EndDateTime = { date: rest.end_date, time: end_time };
        }
        return jsonResult(
          await client.request("/create", {
            method: "POST",
            jsonBody: { ActivityObject: activity },
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_update_object",
    {
      title: "Update (replace) a travel object",
      description:
        "Replace a travel object's data. TripIt's update is a full replace: fields you omit are " +
        "cleared, so fetch the object first (tripit_get_object) and resend everything you want to keep. " +
        "`data` is the raw TripIt object payload (the fields inside e.g. AirObject/LodgingObject).",
      annotations: REPLACES,
      inputSchema: {
        object_type: z
          .enum(WRITABLE_OBJECT_TYPES)
          .describe(`Object type. One of: ${WRITABLE_OBJECT_TYPES.join(", ")}`),
        object_id: z.string().describe("TripIt object ID"),
        data: z
          .record(z.string(), z.unknown())
          .describe("Full replacement object payload in TripIt's field naming"),
      },
    },
    async ({ object_type, object_id, data }) => {
      try {
        return jsonResult(
          await client.request(
            `/replace/${object_type}/id/${encodeURIComponent(object_id)}`,
            { method: "POST", jsonBody: { [WRITABLE_OBJECT_KEYS[object_type]]: data } },
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_delete_object",
    {
      title: "Delete a travel object",
      description:
        "Permanently delete one travel object (flight, hotel, car, activity, ...). This cannot be " +
        "undone — confirm with the user before deleting.",
      annotations: DELETES,
      inputSchema: {
        object_type: objectTypeParam,
        object_id: z.string().describe("TripIt object ID"),
      },
    },
    async ({ object_type, object_id }) => {
      try {
        await client.request(
          `/delete/${object_type}/id/${encodeURIComponent(object_id)}`,
        );
        return jsonResult({ deleted: true, object_type, object_id });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // ==========================================================================
  // Profile & Pro
  // ==========================================================================

  server.registerTool(
    "tripit_get_flight_status",
    {
      title: "Get flight status",
      description:
        "Get an air reservation with real-time status: delays, gates, terminals, and baggage claim. " +
        "Live status data requires the account to have TripIt Pro; without Pro the flight details are " +
        "returned but Status fields are absent. Pass an air object ID from tripit_list_objects or a trip's objects.",
      annotations: READ_ONLY,
      inputSchema: {
        air_id: z.string().describe("Air object ID"),
      },
    },
    async ({ air_id }) => {
      try {
        return jsonResult(
          await client.request(`/get/air/id/${encodeURIComponent(air_id)}`),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_list_points_programs",
    {
      title: "List loyalty programs",
      description:
        "List the user's loyalty/points program memberships with balances, elite status, and expiration. " +
        "Requires TripIt Pro; non-Pro accounts get an empty list.",
      annotations: READ_ONLY,
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await client.request("/list/points_program"));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tripit_get_profile",
    {
      title: "Get user profile",
      description:
        "Get the authenticated TripIt user's profile: name, home city, email addresses, and account flags " +
        "(including whether the account has TripIt Pro).",
      annotations: READ_ONLY,
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await client.request("/get/profile"));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
