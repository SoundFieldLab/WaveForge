export interface HeadPose { yaw: number; pitch: number; roll: number }
const wrap = (value: number) => ((value + 180) % 360 + 360) % 360 - 180

/** 外部姿态输入的校准、时序和滤波；协议为 HSE 右转/抬头/右倾正，单位度。 */
export class HeadPoseFilter {
  private reference: HeadPose = { yaw: 0, pitch: 0, roll: 0 }
  private last: HeadPose = { yaw: 0, pitch: 0, roll: 0 }
  private output: HeadPose = { yaw: 0, pitch: 0, roll: 0 }
  private timestamp = -Infinity
  update(pose: HeadPose, timestamp: number): HeadPose | null {
    if (![pose.yaw, pose.pitch, pose.roll, timestamp].every(Number.isFinite) || timestamp <= this.timestamp) return null
    const alpha = Number.isFinite(this.timestamp) ? 1 - Math.exp(-(timestamp - this.timestamp) / 30) : 1
    this.timestamp = timestamp; this.last = { ...pose }
    this.output.yaw = wrap(this.output.yaw + alpha * wrap(pose.yaw - this.reference.yaw - this.output.yaw))
    this.output.pitch += alpha * (Math.max(-90, Math.min(90, pose.pitch - this.reference.pitch)) - this.output.pitch)
    this.output.roll = wrap(this.output.roll + alpha * wrap(pose.roll - this.reference.roll - this.output.roll))
    return { ...this.output }
  }
  recenter(): HeadPose { this.reference = { ...this.last }; this.output = { yaw: 0, pitch: 0, roll: 0 }; return { ...this.output } }
}
