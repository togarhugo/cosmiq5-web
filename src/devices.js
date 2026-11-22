// The dive computers whose dives the app stores. `cosmiq` arrives over Bluetooth; the others are imported from a file (Shearwater Cloud export
// for the Peregrine and Perdix, FIT files for the Garmin). Keep in step with DEVICES in public/dive-utils.js (a test compares the two).
export const DEVICE_IDS = ["cosmiq", "peregrine", "perdix", "garmin"];
export const IMPORTED_DEVICES = DEVICE_IDS.filter((d) => d !== "cosmiq");
