/**
 * Through-services for lines whose branches do not all run through to each other. Each service is a list of
 * station sequences ridden without changing trains; moving between two services of the same line counts as a change.
 * Sections of such a line that no service covers (e.g. the Mill Hill East shuttle) need a change to reach.
 */
export type LineService = readonly (readonly string[])[];

const NORTHERN_EDGWARE = ['edgware', 'burnt_oak', 'colindale', 'hendon_central', 'brent_cross', 'golders_green', 'hampstead', 'belsize_park', 'chalk_farm', 'camden_town'];
const NORTHERN_HIGH_BARNET = ['high_barnet', 'totteridge_whetstone', 'woodside_park', 'west_finchley', 'finchley_central', 'east_finchley', 'highgate', 'archway', 'tufnell_park', 'kentish_town', 'camden_town'];
const NORTHERN_CHARING_CROSS = ['camden_town', 'mornington_crescent', 'euston', 'warren_street', 'goodge_street', 'tottenham_court_road', 'leicester_square', 'charing_cross', 'embankment', 'waterloo', 'kennington'];
const NORTHERN_BANK = ['camden_town', 'euston', 'kings_cross', 'angel', 'old_street', 'moorgate', 'bank', 'london_bridge', 'borough', 'elephant_castle', 'kennington'];
const NORTHERN_MORDEN = ['kennington', 'oval', 'stockwell', 'clapham_north', 'clapham_common', 'clapham_south', 'balham', 'tooting_bec', 'tooting_broadway', 'colliers_wood', 'south_wimbledon', 'morden'];
const NORTHERN_BATTERSEA = ['kennington', 'nine_elms', 'battersea_power_station'];

export const lineServices: Readonly<Record<string, readonly LineService[]>> = {
  // Edgware and High Barnet trains each run via either Charing Cross or Bank; Battersea is served via Charing Cross.
  northern: [
    [NORTHERN_EDGWARE, NORTHERN_CHARING_CROSS, NORTHERN_BATTERSEA],
    [NORTHERN_EDGWARE, NORTHERN_CHARING_CROSS, NORTHERN_MORDEN],
    [NORTHERN_EDGWARE, NORTHERN_BANK, NORTHERN_MORDEN],
    [NORTHERN_HIGH_BARNET, NORTHERN_CHARING_CROSS, NORTHERN_BATTERSEA],
    [NORTHERN_HIGH_BARNET, NORTHERN_CHARING_CROSS, NORTHERN_MORDEN],
    [NORTHERN_HIGH_BARNET, NORTHERN_BANK, NORTHERN_MORDEN]
  ]
};
