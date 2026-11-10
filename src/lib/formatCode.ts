const pad = (value: number) => String(value).padStart(3, "0");

export const formatUserCode = (userNumber: number) => pad(userNumber);
export const formatPropertyCode = (propertyNumber: number) => `P-${pad(propertyNumber)}`;
export const formatUnitCode = (unitSerial: number) => `U-${pad(unitSerial)}`;
