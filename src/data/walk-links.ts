import type { WalkLinkRecord } from './walk-link';

/**
 * Walking interchanges drawn on the reference map (plus Edgware Road, drawn by this app). Distances are approximate
 * walking distances; `mapPath` follows each connector as drawn, cut to the two stations it joins.
 */
export const walkLinkRecords: readonly WalkLinkRecord[] = [
  { id: 'isi_bank_monument', from: 'bank', to: 'monument', distance: 332, kind: 'isi', mapPath: 'M 1481.75,558 L 1494.75,585' },
  { id: 'isi_liverpool_street_moorgate', from: 'liverpool_street', to: 'moorgate', distance: 350, kind: 'isi', mapPath: 'M 1564,500 L 1521.5,516 1479,500' },
  { id: 'isi_hackney_downs_hackney_central', from: 'hackney_downs', to: 'hackney_central', distance: 200, kind: 'isi', mapPath: 'M 1637.5,278 L 1660.17,295' },
  { id: 'osi_aldgate_tower_gateway', from: 'aldgate', to: 'tower_gateway', distance: 450, kind: 'osi', mapPath: 'M 1601.5,541.5 V 585' },
  { id: 'osi_tower_hill_tower_gateway', from: 'tower_hill', to: 'tower_gateway', distance: 150, kind: 'osi', mapPath: 'M 1563,585 H 1601.5' },
  { id: 'osi_archway_upper_holloway', from: 'archway', to: 'upper_holloway', distance: 650, kind: 'osi', mapPath: 'M 1069,165.75 H 1097' },
  { id: 'osi_farringdon_barbican', from: 'farringdon', to: 'barbican', distance: 200, kind: 'osi', mapPath: 'M 1386,493 H 1415' },
  {
    id: 'osi_bond_street_oxford_circus', from: 'bond_street', to: 'oxford_circus', distance: 400, kind: 'osi',
    mapPath: 'M 1105.75,608.75 v -9.25 l 29.33,-22 q 6,-4.5 13.5,-4.5 L 1153,573'
  },
  { id: 'osi_bow_church_bow_road', from: 'bow_church', to: 'bow_road', distance: 250, kind: 'osi', mapPath: 'M 1900,418 L 1878,434' },
  {
    id: 'osi_kilburn_brondesbury', from: 'kilburn', to: 'brondesbury', distance: 400, kind: 'osi',
    mapPath: 'M 861,309 V 331.5 a 5,5 0 0,1 -2,4 l -40.5,30.375 a 5,5 0 0,0 -2,4 V 376'
  },
  { id: 'osi_canary_wharf_poplar', from: 'canary_wharf', to: 'poplar', distance: 350, kind: 'osi', mapPath: 'M 1893.5,622 V 585' },
  { id: 'osi_canary_wharf_west_india_quay', from: 'canary_wharf', to: 'west_india_quay', distance: 200, kind: 'osi', mapPath: 'M 1893.5,622 L 1880,608.5' },
  { id: 'osi_canary_wharf_heron_quays', from: 'canary_wharf', to: 'heron_quays', distance: 250, kind: 'osi', mapPath: 'M 1893.5,648 L 1880,661' },
  { id: 'osi_camden_town_camden_road', from: 'camden_town', to: 'camden_road', distance: 450, kind: 'osi', mapPath: 'M 1165,278.5 L 1183.5,264.625' },
  { id: 'osi_clapham_high_street_clapham_north', from: 'clapham_high_street', to: 'clapham_north', distance: 150, kind: 'osi', mapPath: 'M 1240.5,946 V 964' },
  { id: 'osi_dalston_kingsland_dalston_junction', from: 'dalston_kingsland', to: 'dalston_junction', distance: 300, kind: 'osi', mapPath: 'M 1583,295 L 1564.625,337' },
  { id: 'osi_edgware_road', from: 'edgware_road_bakerloo', to: 'edgware_road_circle', distance: 250, kind: 'osi', mapPath: 'M 970,545.25 L 981,559' },
  { id: 'osi_euston_euston_square', from: 'euston', to: 'euston_square', distance: 300, kind: 'osi', mapPath: 'M 1212,376.85 L 1201.92,403.5' },
  { id: 'osi_warren_street_euston_square', from: 'warren_street', to: 'euston_square', distance: 350, kind: 'osi', mapPath: 'M 1159.5,403.5 H 1201.92' },
  { id: 'osi_finchley_road_finchley_road_frognal', from: 'finchley_road', to: 'finchley_road_frognal', distance: 400, kind: 'osi', mapPath: 'M 946,372 V 337' },
  { id: 'osi_wanstead_park_forest_gate', from: 'wanstead_park', to: 'forest_gate', distance: 400, kind: 'osi', mapPath: 'M 2041,258 V 280' },
  { id: 'osi_hanger_lane_park_royal', from: 'hanger_lane', to: 'park_royal', distance: 550, kind: 'osi', mapPath: 'M 372,620.4 L 384,643' },
  { id: 'osi_west_ruislip_ickenham', from: 'west_ruislip', to: 'ickenham', distance: 1200, kind: 'osi', mapPath: 'M 142,277.5 L 116.67,296.5' },
  { id: 'osi_kentish_town_kentish_town_west', from: 'kentish_town', to: 'kentish_town_west', distance: 600, kind: 'osi', mapPath: 'M 1128,210 L 1106.67,226' },
  { id: 'osi_kenton_northwick_park', from: 'kenton', to: 'northwick_park', distance: 450, kind: 'osi', mapPath: 'M 531.5,274 L 516.5,294' },
  { id: 'osi_leytonstone_leytonstone_high_road', from: 'leytonstone', to: 'leytonstone_high_road', distance: 600, kind: 'osi', mapPath: 'M 1926,148 L 1940,186' },
  { id: 'osi_manor_park_woodgrange_park', from: 'manor_park', to: 'woodgrange_park', distance: 500, kind: 'osi', mapPath: 'M 2090,243.25 V 266.5' },
  { id: 'osi_seven_sisters_south_tottenham', from: 'seven_sisters', to: 'south_tottenham', distance: 450, kind: 'osi', mapPath: 'M 1426.67,113 V 138' },
  {
    id: 'osi_walthamstow_central_walthamstow_queens_road', from: 'walthamstow_central', to: 'walthamstow_queens_road', distance: 350, kind: 'osi',
    mapPath: 'M 1682,113 L 1700.75,138'
  },
  { id: 'osi_white_city_wood_lane', from: 'white_city', to: 'wood_lane', distance: 250, kind: 'osi', mapPath: 'M 624,723.9 L 637,742.9' },
  { id: 'osi_woolwich_woolwich_arsenal', from: 'woolwich', to: 'woolwich_arsenal', distance: 350, kind: 'osi', mapPath: 'M 2320.67,679.5 L 2288,704' },
  { id: 'osi_new_cross_new_cross_gate', from: 'new_cross', to: 'new_cross_gate', distance: 650, kind: 'osi', mapPath: 'M 1734.67,811 L 1700,837' }
];
