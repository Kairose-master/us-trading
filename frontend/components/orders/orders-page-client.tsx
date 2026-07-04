"use client"

import { Card } from "@/components/primitives"
import { OrderTicket } from "@/components/orders/order-ticket"
import { OrdersTable } from "@/components/orders/orders-table"

export function OrdersPageClient() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold">주문</h1>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="h-fit p-4 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold">주문 입력</h2>
          <OrderTicket />
        </Card>
        <div className="lg:col-span-3">
          <OrdersTable />
        </div>
      </div>
    </div>
  )
}
