import { isEqual } from 'lodash';

interface CartItem {
  id: string;
  quantity: number;
}

export function cartItemsMatch(a: CartItem, b: CartItem): boolean {
  return isEqual(a, b);
}

export function cartListsMatch(a: CartItem[], b: CartItem[]): boolean {
  return isEqual(a, b);
}
