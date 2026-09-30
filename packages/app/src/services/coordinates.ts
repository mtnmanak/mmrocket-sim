/** Display only: keep the stored coordinate's precision for every calculation and write. */
export function coordinateLabel(value: number, axis: 'latitude' | 'longitude', digits = 3): string {
  const hemisphere = axis === 'latitude' ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  return `${Math.abs(value).toFixed(digits)}° ${hemisphere}`;
}

export function coordinatesLabel(latitudeDeg: number, longitudeDeg: number): string {
  return `${coordinateLabel(latitudeDeg, 'latitude')}, ${coordinateLabel(longitudeDeg, 'longitude')}`;
}

/** Derive coordinate labels even for weather records saved before hemisphere labels existed. */
export function weatherPlaceLabel(place: {
  label: string; method: string; latitudeDeg: number; longitudeDeg: number;
}): string {
  return place.method === 'search' ? place.label : coordinatesLabel(place.latitudeDeg, place.longitudeDeg);
}
