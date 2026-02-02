import { Button } from "./Button";
import { Input } from "./Input";

export function App() {
  return (
    <div className="m-3 p-3 border">
      <h1 className="text-blue-500">Hello World</h1>
      <hr className="my-2" />
      <Button />
      <hr className="my-2" />
      <Input />
    </div>
  )
}
