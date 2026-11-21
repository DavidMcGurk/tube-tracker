/**
 * Through-services for lines whose branches do not all run through to each other. Each service is a list of
 * station sequences ridden without changing trains; moving between two services of the same line counts as a change,
 * so a route can't "stay on the train" while reversing at a junction (e.g. Uxbridge → Heathrow at Acton Town).
 * Sections of such a line that no service covers (e.g. the Mill Hill East shuttle) need a change to reach.
 * Lines not listed here run as one service end to end.
 */
export type LineService = readonly (readonly string[])[];

/* Central */
const CENTRAL_WEST_RUISLIP = ['west_ruislip', 'ruislip_gardens', 'south_ruislip', 'northolt', 'greenford', 'perivale', 'hanger_lane', 'north_acton'];
const CENTRAL_EALING = ['ealing_broadway', 'west_acton', 'north_acton'];
const CENTRAL_TRUNK = [
  'north_acton', 'east_acton', 'white_city', 'shepherds_bush', 'holland_park', 'notting_hill_gate', 'queensway', 'lancaster_gate',
  'marble_arch', 'bond_street', 'oxford_circus', 'tottenham_court_road', 'holborn', 'chancery_lane', 'st_paul_s', 'bank',
  'liverpool_street', 'bethnal_green_central', 'mile_end', 'stratford', 'leyton', 'leytonstone'
];
const CENTRAL_EPPING = ['leytonstone', 'snaresbrook', 'south_woodford', 'woodford', 'buckhurst_hill', 'loughton', 'debden', 'theydon_bois', 'epping'];
const CENTRAL_HAINAULT = [
  'leytonstone', 'wanstead', 'redbridge', 'gants_hill', 'newbury_park', 'barkingside', 'fairlop', 'hainault', 'grange_hill', 'chigwell',
  'roding_valley', 'woodford'
];

/* Circle: Hammersmith round to Bayswater, and the loop's other end from Edgware Road via Paddington (Praed Street). */
const CIRCLE_HAMMERSMITH = ['hammersmith', 'goldhawk_road', 'shepherd_s_bush_market', 'wood_lane', 'latimer_road', 'ladbroke_grove', 'westbourne_park', 'royal_oak', 'paddington'];
const CIRCLE_LOOP = [
  'edgware_road_circle', 'baker_street', 'great_portland_street', 'euston_square', 'kings_cross', 'farringdon', 'barbican', 'moorgate',
  'liverpool_street', 'aldgate', 'tower_hill', 'monument', 'cannon_street', 'mansion_house', 'blackfriars', 'temple', 'embankment',
  'westminster', 'st_james_s_park', 'victoria', 'sloane_square', 'south_kensington', 'gloucester_road', 'high_street_kensington',
  'notting_hill_gate', 'bayswater'
];

/* District */
const DISTRICT_EALING = ['ealing_broadway', 'ealing_common', 'acton_town', 'chiswick_park', 'turnham_green'];
const DISTRICT_RICHMOND = ['richmond', 'kew_gardens', 'gunnersbury', 'turnham_green'];
const DISTRICT_HAMMERSMITH = ['turnham_green', 'stamford_brook', 'ravenscourt_park', 'hammersmith', 'barons_court', 'west_kensington', 'earl_s_court'];
const DISTRICT_EAST = [
  'earl_s_court', 'gloucester_road', 'south_kensington', 'sloane_square', 'victoria', 'st_james_s_park', 'westminster', 'embankment', 'temple',
  'blackfriars', 'mansion_house', 'cannon_street', 'monument', 'tower_hill', 'aldgate_east', 'whitechapel', 'stepney_green', 'mile_end',
  'bow_road', 'bromley_by_bow', 'west_ham', 'plaistow', 'upton_park', 'east_ham', 'barking', 'upney', 'becontree', 'dagenham_heathway',
  'dagenham_east', 'elm_park', 'hornchurch', 'upminster_bridge', 'upminster'
];
const DISTRICT_EDGWARE_ROAD = ['earl_s_court', 'high_street_kensington', 'notting_hill_gate', 'bayswater', 'paddington', 'edgware_road_circle'];
const DISTRICT_WIMBLEDON = ['earl_s_court', 'west_brompton', 'fulham_broadway', 'parsons_green', 'putney_bridge', 'east_putney', 'southfields', 'wimbledon_park', 'wimbledon'];
const DISTRICT_OLYMPIA = ['kensington_olympia', 'earl_s_court'];

/* Metropolitan: the Willesden Green link is an alternative path between Finchley Road and Wembley Park. */
const METROPOLITAN_CORE = [
  ['aldgate', 'liverpool_street', 'moorgate', 'barbican', 'farringdon', 'kings_cross', 'euston_square', 'great_portland_street', 'baker_street', 'finchley_road', 'wembley_park'],
  ['finchley_road', 'willesden_green', 'wembley_park'],
  ['wembley_park', 'preston_road', 'northwick_park', 'harrow_on_the_hill']
];
const METROPOLITAN_UXBRIDGE = ['harrow_on_the_hill', 'west_harrow', 'rayners_lane', 'eastcote', 'ruislip_manor', 'ruislip', 'ickenham', 'hillingdon', 'uxbridge'];
const METROPOLITAN_NORTH = ['harrow_on_the_hill', 'north_harrow', 'pinner', 'northwood_hills', 'northwood', 'moor_park'];
const METROPOLITAN_WATFORD = ['moor_park', 'croxley', 'watford'];
const METROPOLITAN_RICKMANSWORTH = ['moor_park', 'rickmansworth', 'chorleywood', 'chalfont_latimer'];

/* Northern */
const NORTHERN_EDGWARE = ['edgware', 'burnt_oak', 'colindale', 'hendon_central', 'brent_cross', 'golders_green', 'hampstead', 'belsize_park', 'chalk_farm', 'camden_town'];
const NORTHERN_HIGH_BARNET = ['high_barnet', 'totteridge_whetstone', 'woodside_park', 'west_finchley', 'finchley_central', 'east_finchley', 'highgate', 'archway', 'tufnell_park', 'kentish_town', 'camden_town'];
const NORTHERN_CHARING_CROSS = ['camden_town', 'mornington_crescent', 'euston', 'warren_street', 'goodge_street', 'tottenham_court_road', 'leicester_square', 'charing_cross', 'embankment', 'waterloo', 'kennington'];
const NORTHERN_BANK = ['camden_town', 'euston', 'kings_cross', 'angel', 'old_street', 'moorgate', 'bank', 'london_bridge', 'borough', 'elephant_castle', 'kennington'];
const NORTHERN_MORDEN = ['kennington', 'oval', 'stockwell', 'clapham_north', 'clapham_common', 'clapham_south', 'balham', 'tooting_bec', 'tooting_broadway', 'colliers_wood', 'south_wimbledon', 'morden'];
const NORTHERN_BATTERSEA = ['kennington', 'nine_elms', 'battersea_power_station'];

/* Piccadilly: Terminal 4 is served one way round a loop from Hatton Cross back via Terminals 2 & 3. */
const PICCADILLY_TRUNK = [
  'cockfosters', 'oakwood', 'southgate', 'arnos_grove', 'bounds_green', 'wood_green', 'turnpike_lane', 'manor_house', 'finsbury_park', 'arsenal',
  'holloway_road', 'caledonian_road', 'kings_cross', 'russell_square', 'holborn', 'covent_garden', 'leicester_square', 'piccadilly_circus',
  'green_park', 'hyde_park_corner', 'knightsbridge', 'south_kensington', 'gloucester_road', 'earl_s_court', 'barons_court', 'hammersmith',
  'turnham_green', 'acton_town'
];
const PICCADILLY_UXBRIDGE = [
  'acton_town', 'ealing_common', 'north_ealing', 'park_royal', 'alperton', 'sudbury_town', 'sudbury_hill', 'south_harrow', 'rayners_lane',
  'eastcote', 'ruislip_manor', 'ruislip', 'ickenham', 'hillingdon', 'uxbridge'
];
const PICCADILLY_HOUNSLOW = ['acton_town', 'south_ealing', 'northfields', 'boston_manor', 'osterley', 'hounslow_east', 'hounslow_central', 'hounslow_west', 'hatton_cross'];
const PICCADILLY_TERMINAL_5 = ['hatton_cross', 'heathrow_terminals_2_3', 'heathrow_terminal_5'];
const PICCADILLY_TERMINAL_4_LOOP = ['hatton_cross', 'heathrow_terminal_4', 'heathrow_terminals_2_3', 'hatton_cross'];

/* Mildmay: Richmond and Clapham Junction trains each run to Stratford. */
const MILDMAY_RICHMOND = ['richmond', 'kew_gardens', 'gunnersbury', 'south_acton', 'acton_central', 'willesden_junction'];
const MILDMAY_CLAPHAM = ['clapham_junction', 'imperial_wharf', 'west_brompton', 'kensington_olympia', 'shepherds_bush', 'willesden_junction'];
const MILDMAY_STRATFORD = [
  'willesden_junction', 'kensal_rise', 'brondesbury_park', 'brondesbury', 'west_hampstead', 'finchley_road_frognal', 'hampstead_heath',
  'gospel_oak', 'kentish_town_west', 'camden_road', 'caledonian_road_barnsbury', 'highbury_islington', 'canonbury', 'dalston_kingsland',
  'hackney_central', 'homerton', 'hackney_wick', 'stratford'
];

/* Windrush */
const WINDRUSH_TRUNK = [
  'highbury_islington', 'canonbury', 'dalston_junction', 'haggerston', 'hoxton', 'shoreditch_high_street', 'whitechapel', 'shadwell', 'wapping',
  'rotherhithe', 'canada_water', 'surrey_quays'
];
const WINDRUSH_SYDENHAM = ['surrey_quays', 'new_cross_gate', 'brockley', 'honor_oak_park', 'forest_hill', 'sydenham'];
const WINDRUSH_WEST_CROYDON = ['sydenham', 'penge_west', 'anerley', 'norwood_junction', 'west_croydon'];
const WINDRUSH_CRYSTAL_PALACE = ['sydenham', 'crystal_palace'];
const WINDRUSH_CLAPHAM = ['surrey_quays', 'queens_road_peckham', 'peckham_rye', 'denmark_hill', 'clapham_high_street', 'wandsworth_road', 'clapham_junction'];
const WINDRUSH_NEW_CROSS = ['surrey_quays', 'new_cross'];

/* Weaver */
const WEAVER_CITY = ['liverpool_street', 'bethnal_green_weaver', 'cambridge_heath', 'london_fields', 'hackney_downs'];
const WEAVER_SEVEN_SISTERS = ['hackney_downs', 'rectory_road', 'stoke_newington', 'stamford_hill', 'seven_sisters', 'bruce_grove', 'white_hart_lane', 'silver_street', 'edmonton_green'];
const WEAVER_ENFIELD = ['edmonton_green', 'bush_hill_park', 'enfield_town'];
const WEAVER_CHESHUNT = ['edmonton_green', 'southbury', 'turkey_street', 'theobalds_grove', 'cheshunt'];
const WEAVER_CHINGFORD = ['hackney_downs', 'clapton', 'st_james_street', 'walthamstow_central', 'wood_street', 'highams_park', 'chingford'];

/* DLR */
const DLR_BANK = ['bank', 'shadwell', 'limehouse', 'westferry'];
const DLR_TOWER_GATEWAY = ['tower_gateway', 'shadwell', 'limehouse', 'westferry'];
const DLR_LEWISHAM = ['canary_wharf', 'heron_quays', 'south_quay', 'crossharbour', 'mudchute', 'island_gardens', 'cutty_sark_for_maritime_greenwich', 'greenwich', 'deptford_bridge', 'elverson_road', 'lewisham'];
const DLR_STRATFORD_POPLAR = ['stratford', 'pudding_mill_lane', 'bow_church', 'devons_road', 'langdon_park', 'all_saints', 'poplar'];
const DLR_POPLAR_CANNING_TOWN = ['poplar', 'blackwall', 'east_india', 'canning_town'];
const DLR_BECKTON = ['canning_town', 'royal_victoria', 'custom_house_for_excel', 'prince_regent', 'royal_albert', 'beckton_park', 'cyprus', 'gallions_reach', 'beckton'];
const DLR_WOOLWICH = ['canning_town', 'west_silvertown', 'pontoon_dock', 'london_city_airport', 'king_george_v', 'woolwich_arsenal'];
const DLR_STRATFORD_CANNING_TOWN = ['stratford_international', 'stratford', 'stratford_high_street', 'abbey_road', 'west_ham', 'star_lane', 'canning_town'];

/* Elizabeth: west branches each run through the central section to Shenfield or Abbey Wood; plus Liverpool Street–Shenfield. */
const ELIZABETH_READING = ['reading', 'twyford', 'maidenhead', 'taplow', 'burnham', 'slough', 'langley', 'iver', 'west_drayton', 'hayes_harlington'];
const ELIZABETH_TERMINAL_5 = ['heathrow_terminal_5', 'heathrow_terminals_2_3', 'hayes_harlington'];
const ELIZABETH_TERMINAL_4 = ['heathrow_terminal_4', 'heathrow_terminals_2_3', 'hayes_harlington'];
const ELIZABETH_CENTRAL = [
  'hayes_harlington', 'southall', 'hanwell', 'west_ealing', 'ealing_broadway', 'acton_main_line', 'paddington', 'bond_street',
  'tottenham_court_road', 'farringdon', 'liverpool_street', 'whitechapel'
];
const ELIZABETH_SHENFIELD = ['stratford', 'maryland', 'forest_gate', 'manor_park', 'ilford', 'seven_kings', 'goodmayes', 'chadwell_heath', 'romford', 'gidea_park', 'harold_wood', 'brentwood', 'shenfield'];
const ELIZABETH_ABBEY_WOOD = ['whitechapel', 'canary_wharf', 'custom_house_for_excel', 'woolwich', 'abbey_wood'];

const combinations = (starts: readonly (readonly string[])[], ends: readonly (readonly (readonly string[])[])[]) =>
  starts.flatMap((start) => ends.map((end): LineService => [start, ...end]));

/**
 * Lines whose services are parts of one continuous train, split only so a route can't loop back on itself: a Circle
 * line train carries on round the loop, so nobody changes between its two services.
 */
export const continuousServiceLines: ReadonlySet<string> = new Set(['circle']);

export const lineServices: Readonly<Record<string, readonly LineService[]>> = {
  central: combinations([CENTRAL_WEST_RUISLIP, CENTRAL_EALING], [[CENTRAL_TRUNK, CENTRAL_EPPING], [CENTRAL_TRUNK, CENTRAL_HAINAULT]]),
  circle: [
    [CIRCLE_HAMMERSMITH, ['paddington', 'edgware_road_circle'], CIRCLE_LOOP],
    [CIRCLE_LOOP.slice(1), ['bayswater', 'paddington', 'edgware_road_circle']]
  ],
  district: [
    [DISTRICT_EALING, DISTRICT_HAMMERSMITH, DISTRICT_EAST],
    [DISTRICT_RICHMOND, DISTRICT_HAMMERSMITH, DISTRICT_EAST],
    [DISTRICT_WIMBLEDON, DISTRICT_EAST],
    [DISTRICT_WIMBLEDON, DISTRICT_EDGWARE_ROAD],
    [DISTRICT_OLYMPIA, DISTRICT_EDGWARE_ROAD]
  ],
  metropolitan: [
    [...METROPOLITAN_CORE, METROPOLITAN_UXBRIDGE],
    [...METROPOLITAN_CORE, METROPOLITAN_NORTH, METROPOLITAN_WATFORD],
    [...METROPOLITAN_CORE, METROPOLITAN_NORTH, METROPOLITAN_RICKMANSWORTH, ['chalfont_latimer', 'amersham']],
    [...METROPOLITAN_CORE, METROPOLITAN_NORTH, METROPOLITAN_RICKMANSWORTH, ['chalfont_latimer', 'chesham']]
  ],
  // Edgware and High Barnet trains each run via either Charing Cross or Bank; Battersea is served via Charing Cross.
  northern: combinations([NORTHERN_EDGWARE, NORTHERN_HIGH_BARNET], [
    [NORTHERN_CHARING_CROSS, NORTHERN_BATTERSEA],
    [NORTHERN_CHARING_CROSS, NORTHERN_MORDEN],
    [NORTHERN_BANK, NORTHERN_MORDEN]
  ]),
  piccadilly: [
    [PICCADILLY_TRUNK, PICCADILLY_UXBRIDGE],
    [PICCADILLY_TRUNK, PICCADILLY_HOUNSLOW, PICCADILLY_TERMINAL_5],
    [PICCADILLY_TRUNK, PICCADILLY_HOUNSLOW, PICCADILLY_TERMINAL_4_LOOP]
  ],
  mildmay: [
    [MILDMAY_RICHMOND, MILDMAY_STRATFORD],
    [MILDMAY_CLAPHAM, MILDMAY_STRATFORD]
  ],
  windrush: [
    [WINDRUSH_TRUNK, WINDRUSH_SYDENHAM, WINDRUSH_WEST_CROYDON],
    [WINDRUSH_TRUNK, WINDRUSH_SYDENHAM, WINDRUSH_CRYSTAL_PALACE],
    [WINDRUSH_TRUNK, WINDRUSH_CLAPHAM],
    [WINDRUSH_TRUNK, WINDRUSH_NEW_CROSS]
  ],
  weaver: [
    [WEAVER_CITY, WEAVER_SEVEN_SISTERS, WEAVER_ENFIELD],
    [WEAVER_CITY, WEAVER_SEVEN_SISTERS, WEAVER_CHESHUNT],
    [WEAVER_CITY, WEAVER_CHINGFORD]
  ],
  dlr: [
    [DLR_BANK, ['westferry', 'canary_wharf'], DLR_LEWISHAM],
    [DLR_BANK, ['westferry', 'west_india_quay', 'canary_wharf'], DLR_LEWISHAM],
    [DLR_STRATFORD_POPLAR, ['poplar', 'west_india_quay', 'canary_wharf'], DLR_LEWISHAM],
    [DLR_BANK, ['westferry', 'poplar'], DLR_POPLAR_CANNING_TOWN, DLR_WOOLWICH],
    [DLR_TOWER_GATEWAY, ['westferry', 'poplar'], DLR_POPLAR_CANNING_TOWN, DLR_BECKTON],
    [DLR_STRATFORD_CANNING_TOWN, DLR_WOOLWICH]
  ],
  elizabeth: [
    ...combinations([ELIZABETH_READING, ELIZABETH_TERMINAL_5, ELIZABETH_TERMINAL_4], [
      [ELIZABETH_CENTRAL, ['whitechapel', 'stratford'], ELIZABETH_SHENFIELD],
      [ELIZABETH_CENTRAL, ELIZABETH_ABBEY_WOOD]
    ]),
    [['liverpool_street', 'stratford'], ELIZABETH_SHENFIELD]
  ]
};
