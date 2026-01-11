export const LIFE_LOG = {
  "user_profile": {
    "name": "Alice",
    "condition": "Early-stage Alzheimer's",
    "notes": "Gets anxious when she can't find her medication or glasses.",
    "home_coordinates": { "lat": 40.7128, "lng": -74.0060 }
  },
  "medication_reminders": [
    { 
      "time": "09:00", 
      "medication": "Lisinopril (Blood Pressure)", 
      "dosage": "10mg", 
      "location": "Blue pill bottle on kitchen counter", 
      "instructions": "Take with water" 
    },
    { 
      "time": "13:00", 
      "medication": "Multivitamin", 
      "dosage": "1 tablet", 
      "location": "Kitchen table", 
      "instructions": "Take after lunch" 
    },
    { 
      "time": "20:00", 
      "medication": "Donepezil", 
      "dosage": "5mg", 
      "location": "Nightstand", 
      "instructions": "Take before bed" 
    }
  ],
  "daily_routine": [
    { "time": "09:00", "task": "Take blood pressure medication (blue pill bottle)" },
    { "time": "13:00", "task": "Lunch with caregiver" },
    { "time": "18:00", "task": "Water the plants in the living room" }
  ],
  "social_circle": [
    { "name": "Leo", "relationship": "Grandson", "phone": "555-0101", "last_visit": "2026-01-05", "description": "Young man, late 20s, usually wears glasses." },
    { "name": "Sarah", "relationship": "Caregiver", "phone": "555-0199", "description": "Middle-aged woman, wears a blue uniform." }
  ],
  "home_map": {
    "kitchen": {
      "description": "Contains medication cabinet near the fridge.",
      "critical_items": ["blue pill bottle", "water glass"],
      "privacy_sensitive": false
    },
    "living_room": {
      "description": "Has the TV and large window.",
      "critical_items": ["remote", "glasses"],
      "privacy_sensitive": false
    },
    "hallway": {
      "description": "Connects bedroom to kitchen.",
      "critical_items": ["emergency button"],
      "privacy_sensitive": false
    },
    "bathroom": {
      "description": "Master bathroom with white tiles.",
      "critical_items": ["towel", "cabinet"],
      "privacy_sensitive": true
    },
    "bedroom": {
      "description": "Sleeping area with bed and wardrobe.",
      "critical_items": ["nightstand"],
      "privacy_sensitive": true
    }
  }
};