/**
 * Character controller and physics configuration constants.
 * All balance and tuning parameters are strictly defined here without magic numbers.
 */

export const COLLISION_GROUPS = {
  // 16-bit bitmasks for Rapier interaction groups
  // [membership] [filter]
  // Group 0: Default Environment (static/terrain)
  ENVIRONMENT: 0x0001,
  // Group 1: Character Dynamic Body
  CHARACTER: 0x0002,
  // Group 2: Dynamic Props (pushable crates, balls)
  DYNAMIC_PROPS: 0x0004,
  // Group 3: Trigger / Sensor zones
  TRIGGERS: 0x0008,
  // Group 4: Camera Occlusion Query (exclude character)
  CAMERA_RAY: 0x0010,
} as const;

export const PHYSICS_CONFIG = {
  GRAVITY: -22.0, // m/s^2 - responsive platformer feel
  FIXED_TIMESTEP: 1 / 60,
  MAX_SUB_STEPS: 3,
  LINEAR_DAMPING: 0.1,
  ANGULAR_DAMPING: 10.0,
} as const;

export const CHARACTER_CONFIG = {
  // Capsule / Physics dimensions (Total height = 1.50m)
  CAPSULE_RADIUS: 0.30,
  CAPSULE_HALF_HEIGHT: 0.45, // Total height = 2 * 0.45 + 2 * 0.30 = 1.50m
  MASS: 70.0, // kg

  // Ground detection parameters
  GROUND_RAY_COUNT: 5, // Center + 4 cardinal offsets
  GROUND_RAY_OFFSET_RADIUS: 0.16, // Probes stay well inside 0.30 radius to prevent wall false positives
  GROUND_RAY_LENGTH: 0.87, // Center is 0.75m from bottom, +0.12m contact tolerance
  MAX_WALKABLE_SLOPE_DEG: 48.0, // Max walkable slope before sliding

  // Locomotion balance & acceleration curves
  // Normal movement is a jog on the generated RUN cycle (~4.7 m/s at 1x, see ProceduralRunClip);
  // CharacterModel scales clip playback to the actual speed so feet stay planted
  WALK_SPEED: 4.5, // m/s
  SPRINT_SPEED: 7.0, // m/s
  CROUCH_SPEED: 1.1, // m/s, below the WALK -> RUN switch so crouching keeps the WALK clip
  INITIAL_ACCELERATION: 25.0, // m/s^2 smooth start acceleration from standstill
  GROUND_ACCELERATION: 42.0, // m/s^2 top acceleration once moving
  GROUND_DECELERATION: 38.0, // m/s^2 natural braking deceleration
  TURNING_DECELERATION: 25.0, // m/s^2 skid response when turning direction
  AIR_ACCELERATION: 18.0,
  AIR_DECELERATION: 4.0,

  // Squash & Stretch dynamics (Mario Odyssey style)
  SQUASH_JUMP_SQUAT: 0.76, // Y scale compression right before jump launch
  SQUASH_JUMP_LAUNCH: 1.28, // Y scale elongation during upward jump impulse
  SQUASH_LAND_MIN: 0.62, // Maximum Y scale squash on heavy landing
  SQUASH_SPRING_STIFFNESS: 280.0, // Harmonic oscillator stiffness
  SQUASH_SPRING_DAMPING: 16.0, // Harmonic oscillator damping factor

  // Slope Anti-Slide
  SLOPE_HOLD_RESISTANCE: 1.2,
  SLOPE_MIN_VELOCITY_THRESHOLD: 0.08,

  // Jump dynamics
  JUMP_IMPULSE: 8.5, // m/s initial upward velocity
  JUMP_CUT_MULTIPLIER: 14.0, // Damping rate applied when releasing jump button early
  COYOTE_TIME: 0.16, // seconds grace period after leaving ledge
  JUMP_BUFFER_TIME: 0.14, // seconds buffer when pressing jump early
  AIR_CONTROL_FACTOR: 0.3,
  ALLOW_STEEP_SLOPE_JUMP: true, // Allow jumping off steep, non-walkable slopes

  // Dash ability
  DASH_IMPULSE: 18.0,
  DASH_COOLDOWN: 1.2, // seconds
  DASH_DURATION: 0.18, // seconds

  // Wall climb ability
  ENABLE_WALL_CLIMB: false, // Master toggle to enable/disable wall climbing mechanic

  // Visual Lean Effect
  MAX_LEAN_PITCH: 0.18, // radians forward/backward lean during acceleration
  MAX_LEAN_ROLL: 0.22,  // radians roll/banking lean during sharp turns
  LEAN_SMOOTH_SPEED: 12.0, // interpolation speed

  // Particles
  FOOT_DUST_ENABLED: false, // footstep / jump / landing dust puffs under the player
  DUST_WALK_INTERVAL: 0.05, // seconds between footstep dust puffs
  DUST_SPRINT_INTERVAL: 0.05, // seconds between sprint dust puffs
  DUST_JUMP_COUNT: 6, // number of particles spawned on jump takeoff
  DUST_LAND_COUNT: 6, // number of particles spawned on landing
  PARTICLE_MAX_COUNT: 128,

  // Visual Mesh
  MODEL_HEIGHT: 1.5,
  TURN_SMOOTH_FACTOR: 10.0, // Radians/s slerp rate for facing direction
} as const;

export const CARRY_CONFIG = {
  PICKUP_RADIUS: 2.8, // Maximum distance to pick up dynamic props (meters)
  HOLD_HEIGHT_OFFSET: 1.4, // Overhead height offset relative to character center (meters)
  THROW_FORCE: 16.0, // Throw impulse magnitude (m/s)
  CAMERA_RIGHT_OFFSET: 1.0, // Camera side offset to the right when holding overhead (units)
  THROW_UPWARD_ANGLE: 0.45, // Upward angle component for throw trajectory
} as const;

export const CAMERA_CONFIG = {
  DEFAULT_DISTANCE: 4.2,
  MIN_DISTANCE: 0.3,
  MAX_DISTANCE: 8.0,
  DEFAULT_HEIGHT_OFFSET: 0.75, // Look-at height above character center (~1.2m above feet)
  FOV: 65,
  PITCH_MIN: -75.0 * (Math.PI / 180), // Downward look limit
  PITCH_MAX: 70.0 * (Math.PI / 180),  // Upward look limit
  MOUSE_SENSITIVITY: 0.0022,
  POSITION_SMOOTH_SPEED: 12.0, // Damping rate for following character position
  ROTATION_SMOOTH_SPEED: 12.0, // Smooth, responsive camera rotation interpolation speed
  OCCLUSION_OFFSET_PADDING: 0.1, // Safe gap from walls on collision
  // GTA 5 Recoil Spring Tuning
  RECOIL_SPRING_STIFFNESS: 240.0,
  RECOIL_SPRING_DAMPING: 22.0,
  RECOIL_ROLL_STIFFNESS: 280.0,
  RECOIL_ROLL_DAMPING: 26.0,
} as const;

export const WATER_FOG_CONFIG = {
  // Master toggle: Set to false to disable vertical/height shader calculations
  ENABLE_HEIGHT_SHADER: false,
  // Volumetric surface mist layer toggle
  ENABLE_VOLUMETRIC_SURFACE_MIST: false,

  // Height / Vertical bounds (fog concentrated between MIN_Y and MAX_Y)
  HEIGHT_MIN_Y: 0.0,
  HEIGHT_MAX_Y: 3.8,

  // Horizontal pool boundary coordinates
  // Water can exist anywhere in the 128 m world (terrain below worldSettings.waterLevel)
  BOUNDS_MIN_X: -64.0,
  BOUNDS_MAX_X: 64.0,
  BOUNDS_MIN_Z: -64.0,
  BOUNDS_MAX_Z: 64.0,

  // Soft boundary blend margin in meters
  FADE_MARGIN: 6.0,

  // Constrain height fog strictly within water bounds (true) or scene-wide (false)
  IS_WATER_BOUNDED: true,

  // Atmospheric colors & densities
  UNDERWATER_FOG_COLOR: 0x007cff,
  UNDERWATER_FOG_DENSITY: 0.028,
  NORMAL_FOG_COLOR: 0xf1f5f9,
  NORMAL_FOG_DENSITY: 0.008,
} as const;

export const WATER_PHYSICS_CONFIG = {
  SURFACE_Y: 0.0,
  SWIM_SURFACE_OFFSET: 0.35, // Resting depth below surface (meters)
  SWIM_BASE_SPEED: 4.5, // m/s, independent of the (slow) walking speed
  SWIM_WALK_SPEED_RATIO: 0.95,
  SWIM_SPRINT_SPEED_RATIO: 1.5,
  SWIM_VERTICAL_SPEED: 4.8,
  WATER_DRAG_HORIZONTAL: 4.5,
  WATER_DRAG_VERTICAL: 3.8,
  ENTRY_SPLASH_VELOCITY_MIN: 1.8, // Minimum downward m/s to trigger splash
  SWIM_STROKE_RIPPLE_INTERVAL: 0.32, // Seconds between swimming surface ripple pulses
  BUBBLE_EMIT_SPEED_THRESHOLD: 4.0, // Speed above which air bubbles spawn
} as const;

export const BUOYANCY_CONFIG = {
  WATER_DENSITY: 1000.0, // kg/m^3
  BUOYANCY_FORCE_SCALE: 1.65, // Multiplier to balance gravity and create floating bobbing
  WATER_LINEAR_DRAG: 2.2, // Linear drag for submerged bodies
  WATER_ANGULAR_DRAG: 3.0, // Angular drag preventing rapid spin
  VERTICAL_DAMPING: 3.2, // Dampens vertical bounce oscillations
  WAVE_AMPLITUDE: 0.06, // Height of sinusoidal wave bobbing (meters)
  WAVE_FREQUENCY: 1.8, // Wave frequency in radians/s
  WAVE_SPATIAL_SCALE: 0.35, // Wave wavelength spatial factor
} as const;

export const WATER_MANTLE_CONFIG = {
  DETECTION_DISTANCE: 1.0, // Max distance to wall/pier from chest
  MIN_LEDGE_HEIGHT: 0.1, // Minimum ledge top height above water surface
  MAX_LEDGE_HEIGHT: 1.6, // Maximum ledge top height reach from water
  MANTLE_LAUNCH_UPWARD: 6.8, // Upward velocity boost (m/s)
  MANTLE_LAUNCH_FORWARD: 3.8, // Forward velocity boost onto platform (m/s)
  MANTLE_COOLDOWN: 0.6, // Seconds grace period after mantling
} as const;

export const WALL_CLIMB_CONFIG = {
  // Master toggle to enable/disable wall climbing mechanic
  ENABLE_WALL_CLIMB: true,
  CLIMB_SPEED_UP: 3.2,
  CLIMB_SPEED_DOWN: 2.5,
  CLIMB_SPEED_HORIZONTAL: 2.8,
  DETECTION_DISTANCE: 0.80,
  VAULT_LAUNCH_UPWARD: 7.5,
  VAULT_LAUNCH_FORWARD: 2.5,
} as const;

export const WATER_EFFECTS_CONFIG = {
  MAX_RIPPLES: 48,
  RIPPLE_EXPANSION_SPEED: 3.2, // meters per second
  RIPPLE_LIFETIME: 1.4, // seconds
  RIPPLE_INITIAL_RADIUS: 0.4,
  MAX_SPLASH_PARTICLES: 120,
  MAX_BUBBLE_PARTICLES: 80,
  CAUSTICS_SPEED: 2.2,
  CAUSTICS_SCALE: 0.3,
  CAUSTICS_INTENSITY: 0.25,
  CAUSTICS_MAX_DISTANCE: 42.0, // Distance in meters beyond which caustics are culled
  CAUSTICS_FADE_START: 20.0, // Distance where smooth distance fading begins
} as const;

export const OXYGEN_CONFIG = {
  MAX_OXYGEN: 100.0,
  BASE_DEPLETION_RATE: 3.5, // % per second while diving underwater (~15s total dive time)
  SPRINT_DEPLETION_RATE: 8.0, // % per second while sprint-swimming or dashing underwater
  RECOVERY_RATE: 38.0, // % per second when surfaced or on land (~2.6s to full recharge)
  WARNING_THRESHOLD: 25.0, // % threshold when ring starts pulsing warning
  CRITICAL_THRESHOLD: 10.0, // % threshold for urgent danger pulse
  DROWNING_BUBBLE_INTERVAL: 0.12, // seconds between distress bubbles when out of oxygen
  SURFACE_HEAD_TOLERANCE: 0.2, // distance in meters below surface considered fully submerged
  PRIMARY_COLOR: '#00ffff', // Zelda BotW cyan stamina wheel color requested
  WARNING_COLOR: '#ffbb00', // Amber warning color
  CRITICAL_COLOR: '#ff3344', // Danger red color
  FULL_RECOVERY_FLASH_DURATION: 0.5, // seconds for green/cyan flash when stamina wheel fills
} as const;

export const AI_STEERING_CONFIG = {
  // Agent physical properties
  AGENT_MASS: 0.5,
  AGENT_MAX_FORCE: 350.0,
  AGENT_BOUNDING_RADIUS: 0.45,

  // Speed limits (m/s)
  ENEMY_CHASE_SPEED: 5.5,
  ENEMY_ENGAGE_SPEED: 4.8,
  FRIENDLY_FOLLOW_SPEED: 4.6,
  PATROL_SPEED: 3.0,
  WANDER_SPEED: 2.4,

  // Steering behavior weights
  FOLLOW_PATH_WEIGHT: 2.2,
  ON_PATH_WEIGHT: 1.2,
  ON_PATH_RADIUS: 0.8,
  OBSTACLE_AVOIDANCE_WEIGHT: 3.8,
  SEPARATION_WEIGHT: 3.2,
  ARRIVE_WEIGHT: 2.0,
  WANDER_WEIGHT: 1.0,

  // Spatial neighborhood & Separation
  NEIGHBORHOOD_RADIUS: 3.5, // radius to search for neighbor agents
  SEPARATION_COMFORT_DISTANCE: 1.4, // comfort spacing between agent centers

  // Dynamic Obstacle Avoidance
  OBSTACLE_DBOX_MIN_LENGTH: 2.2, // minimum length of forward detection corridor
  OBSTACLE_BRAKING_WEIGHT: 0.2, // proportional braking when obstacle directly in front

  // NavMesh pathfinding & tracking parameters
  WAYPOINT_TOLERANCE: 1.0, // distance (m) to advance to next waypoint
  PATH_RECALC_INTERVAL_MS: 240, // minimum milliseconds between A* path recalculations
  TARGET_MOVE_THRESHOLD: 1.2, // distance (m) target must move before triggering A* recalculation
  ATTACK_RANGE: 2.0, // distance (m) where enemy engages in point-blank attack
  FOLLOW_STOP_DISTANCE: 3.2, // distance (m) where friendly NPC idles peacefully behind player
  ENGAGEMENT_VERTICAL_TOLERANCE: 1.2, // max vertical elevation difference for direct engagement
  COMBAT_ZONE_X_THRESHOLD: -55.0, // X coordinate where combat zone starts
  AGGRO_DISTANCE: 70.0, // maximum distance (m) to aggro player

  // Ramp / Stair ascent assistance
  RAMP_ASCENT_THRESHOLD: 0.12, // vertical delta to trigger ramp climbing assist
  RAMP_ASCENT_ASSIST_SPEED: 3.8, // vertical velocity assist on ramps
} as const;

export const BUILDING_CONFIG = {
  // Main building platform top surface level (Y-coordinate)
  GROUND_SURFACE_Y: 0.0,
  // Ratio of piece height submerged in ground when placed directly on terrain/ground (70% below ground, 30% above)
  GROUND_FLOOR_SINK_PERCENT: 0.70,
  // Epsilon tolerance for floating-point calculations to avoid false positives at exact boundary
  MIN_SURFACE_TOLERANCE: -0.05,
} as const;

