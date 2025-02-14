"use client"
import { useTheme } from "next-themes"
import { Sun, Moon } from "lucide-react"
export default function ModeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="flex space-x-2">
      <button onClick={() => setTheme("light")} className={theme==="light" ? "text-blue-500" : "text-gray-500"}>
        <Sun className="h-5 w-5" />
      </button>
      <button onClick={() => setTheme("dark")} className={theme==="dark" ? "text-blue-500" : "text-gray-500"}>
        <Moon className="h-5 w-5" />
      </button>
    </div>
  )
}