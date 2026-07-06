/**
 * Custom bulletproof formatting utilities to avoid cross-browser Intl / toLocaleString bugs
 */

export function safeFormatTime(
  dateInput: Date | string | number | null | undefined,
  showDate = false
): string {
  if (!dateInput) return "";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "";

    const pad = (n: number) => String(n).padStart(2, "0");
    const hours = d.getHours();
    const minutes = pad(d.getMinutes());
    const ampm = hours >= 12 ? "PM" : "AM";
    const hours12 = hours % 12 || 12;
    const formattedTime = `${hours12}:${minutes} ${ampm}`;

    if (showDate) {
      const year = d.getFullYear();
      const month = pad(d.getMonth() + 1);
      const day = pad(d.getDate());
      return `${year}-${month}-${day} ${formattedTime}`;
    }
    return formattedTime;
  } catch (e) {
    return "";
  }
}

export function safeFormatDate(
  dateInput: Date | string | number | null | undefined
): string {
  if (!dateInput) return "";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "";

    const pad = (n: number) => String(n).padStart(2, "0");
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    return `${year}-${month}-${day}`;
  } catch (e) {
    return "";
  }
}

export function safeFormatDateShort(
  dateInput: Date | string | number | null | undefined
): string {
  if (!dateInput) return "";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "";

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[d.getMonth()];
    const day = d.getDate();
    return `${month} ${day}`;
  } catch (e) {
    return "";
  }
}

export function safeFormatDateTimeShort(
  dateInput: Date | string | number | null | undefined
): string {
  if (!dateInput) return "";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "";

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[d.getMonth()];
    const day = d.getDate();

    const pad = (n: number) => String(n).padStart(2, "0");
    const hours = d.getHours();
    const minutes = pad(d.getMinutes());
    const ampm = hours >= 12 ? "PM" : "AM";
    const hours12 = hours % 12 || 12;

    return `${month} ${day}, ${hours12}:${minutes} ${ampm}`;
  } catch (e) {
    return "";
  }
}

export function safeFormatNumber(
  num: number | null | undefined,
  minimumFractionDigits = 2,
  maximumFractionDigits = 2
): string {
  if (num === null || num === undefined || isNaN(num)) {
    return "0" + (minimumFractionDigits > 0 ? "." + "0".repeat(minimumFractionDigits) : "");
  }
  try {
    const fixed = num.toFixed(maximumFractionDigits);
    const parts = fixed.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    
    // Adjust decimals to respect minimumFractionDigits
    if (parts[1]) {
      while (parts[1].length > minimumFractionDigits && parts[1].endsWith("0")) {
        parts[1] = parts[1].slice(0, -1);
      }
      if (parts[1].length < minimumFractionDigits) {
        parts[1] = parts[1] + "0".repeat(minimumFractionDigits - parts[1].length);
      }
      if (parts[1].length === 0) {
        return parts[0];
      }
      return parts.join(".");
    }
    return parts[0];
  } catch (e) {
    return String(num);
  }
}
