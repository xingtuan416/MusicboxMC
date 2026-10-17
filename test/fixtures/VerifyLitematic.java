import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.GZIPInputStream;

/**
 * Read a .litematic with nothing but the JDK, and print what is inside it.
 *
 * This exists to be an authority the project's own code cannot be. A writer verified by its
 * own reader proves only that the two agree; if both misread the specification the same way
 * - which is exactly what happened with NBT strings and Modified UTF-8 - the test stays green
 * forever. Everything here is implemented from the format description, not from the
 * TypeScript: tag framing, readUTF, and the bit packing that crosses 64-bit word boundaries.
 *
 * Usage: java VerifyLitematic.java <file.litematic>
 */
public class VerifyLitematic {
  static class Nbt {
    DataInputStream in;
    Nbt(DataInputStream in) { this.in = in; }

    /** A named tag: type byte, name, payload. Returns the payload value. */
    Object named() throws IOException {
      int type = in.readUnsignedByte();
      if (type == 0) return null;
      String name = in.readUTF();
      Object value = payload(type);
      Map<String, Object> wrapper = new LinkedHashMap<>();
      wrapper.put("__name", name);
      wrapper.put("__type", type);
      wrapper.put("__value", value);
      return wrapper;
    }

    Object payload(int type) throws IOException {
      switch (type) {
        case 1: return in.readByte();
        case 2: return in.readShort();
        case 3: return in.readInt();
        case 4: return in.readLong();
        case 5: return in.readFloat();
        case 6: return in.readDouble();
        case 7: { int n = in.readInt(); byte[] b = new byte[n]; in.readFully(b); return b; }
        case 8: return in.readUTF();
        case 9: {
          int elementType = in.readUnsignedByte();
          int n = in.readInt();
          List<Object> list = new ArrayList<>();
          for (int i = 0; i < n; i++) list.add(payload(elementType));
          Map<String, Object> out = new LinkedHashMap<>();
          out.put("__elementType", elementType);
          out.put("__items", list);
          return out;
        }
        case 10: {
          Map<String, Object> compound = new LinkedHashMap<>();
          while (true) {
            int childType = in.readUnsignedByte();
            if (childType == 0) break;
            String childName = in.readUTF();
            compound.put(childName, payload(childType));
          }
          return compound;
        }
        case 11: { int n = in.readInt(); int[] v = new int[n]; for (int i = 0; i < n; i++) v[i] = in.readInt(); return v; }
        case 12: { int n = in.readInt(); long[] v = new long[n]; for (int i = 0; i < n; i++) v[i] = in.readLong(); return v; }
        default: throw new IOException("unknown tag type " + type);
      }
    }
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> compound(Object value) { return (Map<String, Object>) value; }

  static int intOf(Object compound, String key) {
    return (Integer) compound(compound).get(key);
  }

  /** Unpack one entry from the bit array, crossing word boundaries as the format requires. */
  static int unpack(long[] words, int index, int bits) {
    long bitOffset = (long) index * bits;
    int word = (int) (bitOffset >>> 6);
    int offset = (int) (bitOffset & 63L);
    long value = words[word] >>> offset;
    int available = 64 - offset;
    if (available < bits) value |= words[word + 1] << available;
    return (int) (value & ((1L << bits) - 1));
  }

  @SuppressWarnings("unchecked")
  public static void main(String[] args) throws Exception {
    byte[] compressed = Files.readAllBytes(Paths.get(args[0]));
    DataInputStream in = new DataInputStream(new GZIPInputStream(new ByteArrayInputStream(compressed)));
    Nbt nbt = new Nbt(in);
    Map<String, Object> root = compound(nbt.named());
    Map<String, Object> tags = compound(root.get("__value"));

    System.out.println("root-name=" + root.get("__name"));
    System.out.println("Version=" + tags.get("Version"));
    System.out.println("MinecraftDataVersion=" + tags.get("MinecraftDataVersion"));

    Map<String, Object> metadata = compound(tags.get("Metadata"));
    System.out.println("Metadata.Name=" + metadata.get("Name"));
    System.out.println("Metadata.Author=" + metadata.get("Author"));
    System.out.println("Metadata.RegionCount=" + metadata.get("RegionCount"));

    Map<String, Object> regions = compound(tags.get("Regions"));
    for (String regionName : regions.keySet()) {
      Map<String, Object> region = compound(regions.get(regionName));
      Map<String, Object> size = compound(region.get("Size"));
      Map<String, Object> palette = compound(region.get("BlockStatePalette"));
      List<Object> entries = (List<Object>) palette.get("__items");
      long[] words = (long[]) region.get("BlockStates");

      int sx = (Integer) size.get("x"), sy = (Integer) size.get("y"), sz = (Integer) size.get("z");
      int volume = sx * sy * sz;
      int bits = Math.max(1, 32 - Integer.numberOfLeadingZeros(Math.max(1, entries.size() - 1)));

      System.out.println("region=" + regionName
          + " size=" + sx + "x" + sy + "x" + sz
          + " palette=" + entries.size()
          + " bits=" + bits
          + " words=" + words.length
          + " expectedWords=" + ((long) volume * bits + 63) / 64);

      // Name each cell of the region so the expected block at any position is explicit.
      for (int y = 0; y < sy; y++) {
        for (int z = 0; z < sz; z++) {
          for (int x = 0; x < sx; x++) {
            int index = y * (sx * sz) + z * sx + x;
            int paletteIndex = unpack(words, index, bits);
            Map<String, Object> state = compound(entries.get(paletteIndex));
            System.out.println("  cell(" + x + "," + y + "," + z + ")"
                + " index=" + index
                + " paletteIndex=" + paletteIndex
                + " block=" + state.get("Name"));
          }
        }
      }
    }
  }
}
